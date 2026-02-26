/* ==========================================================
   HEALTHIQ — CHAT UI CONTROLLER
   Manages DOM rendering, user interaction, send flow,
   typing indicator, smart scroll, and clear-chat modal.
   Depends on: HealthIQChatStorage (chat-storage.js)
   ========================================================== */
(function () {
  'use strict';

  // ---- DOM Refs ----
  var chatPill      = document.getElementById('chatPill');
  var chatHistory   = document.getElementById('chatHistory');
  var chatInput     = document.getElementById('aiChatInput');
  var sendBtn       = document.getElementById('aiChatSend');
  var clearBtn      = document.getElementById('chatClearBtn');
  var demoNotice    = document.getElementById('chatDemoNotice');
  var modalOverlay  = document.getElementById('chatModalOverlay');
  var modalCancel   = document.getElementById('chatModalCancel');
  var modalConfirm  = document.getElementById('chatModalConfirm');

  if (!chatHistory || !chatInput || !sendBtn) return;

  var Storage = window.HealthIQChatStorage;
  if (!Storage) {
    console.error('[HealthIQ] chat-storage.js must load before chat-ui.js');
    return;
  }

  // ---- State ----
  var sending = false;
  var typingEl = null;
  var activated = false; // First interaction flag

  // ---- Helpers ----
  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function isNearBottom() {
    var threshold = 80;
    return (chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight) < threshold;
  }

  function scrollToBottom(force) {
    if (force || isNearBottom()) {
      requestAnimationFrame(function () {
        chatHistory.scrollTop = chatHistory.scrollHeight;
      });
    }
  }

  function setInputEnabled(enabled) {
    sending = !enabled;
    sendBtn.disabled = !enabled;
    chatInput.disabled = !enabled;
    sendBtn.textContent = enabled ? 'Send' : '...';
    if (enabled) chatInput.focus();
  }

  function activatePill() {
    if (!activated && chatPill) {
      chatPill.classList.add('chat-active');
      activated = true;
    }
  }

  // ---- Empty State ----
  function renderEmptyState() {
    var el = document.createElement('div');
    el.className = 'chat-empty';
    el.innerHTML =
      '<div class="chat-empty-icon">&#129302;</div>' +
      '<h2>HealthIQ AI</h2>' +
      '<p>Ask questions about your health data. I can help identify patterns, summarize your timeline, and provide general wellness context.</p>' +
      '<p class="chat-empty-hint">I am not a medical professional. My responses are informational only.</p>';
    return el;
  }

  function clearChatHistory() {
    // Remove all messages and typing indicator
    while (chatHistory.firstChild) {
      chatHistory.removeChild(chatHistory.firstChild);
    }
    typingEl = null;
  }

  function showEmptyIfNeeded() {
    var msgs = chatHistory.querySelectorAll('.chat-msg');
    if (msgs.length === 0 && !chatHistory.querySelector('.chat-empty')) {
      chatHistory.appendChild(renderEmptyState());
    }
  }

  function removeEmptyState() {
    var empty = chatHistory.querySelector('.chat-empty');
    if (empty) empty.remove();
  }

  // ---- Message Rendering ----
  function addMessageDOM(role, text, options) {
    options = options || {};
    removeEmptyState();

    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'ai');
    if (options.restored) div.classList.add('restored');

    var labelText = role === 'user' ? 'You' : 'HealthIQ AI';
    var bubbleClass = 'chat-bubble';
    if (options.error) bubbleClass += ' error-bubble';
    if (options.demo) bubbleClass += ' demo-bubble';

    var html = '<div class="chat-label">' + escapeHtml(labelText) + '</div>';
    html += '<div class="' + bubbleClass + '">' + escapeHtml(text);

    if (options.disclaimer) {
      html += '<span class="chat-disclaimer-inline">' + escapeHtml(options.disclaimer) + '</span>';
    }

    html += '</div>';
    div.innerHTML = html;

    chatHistory.appendChild(div);
    scrollToBottom(options.forceScroll);

    // Prune DOM if too many
    pruneDOM();
  }

  function pruneDOM() {
    var msgs = chatHistory.querySelectorAll('.chat-msg');
    if (msgs.length > Storage.MAX_MESSAGES) {
      var toRemove = msgs.length - Storage.MAX_MESSAGES;
      for (var i = 0; i < toRemove; i++) {
        msgs[i].remove();
      }
    }
  }

  // ---- Typing Indicator ----
  function showTyping() {
    if (typingEl) return;
    removeEmptyState();

    typingEl = document.createElement('div');
    typingEl.className = 'chat-typing-wrap';
    typingEl.id = 'chatTypingIndicator';
    typingEl.innerHTML =
      '<div class="chat-label">HealthIQ AI</div>' +
      '<div class="chat-typing-bubble"><span></span><span></span><span></span></div>';
    chatHistory.appendChild(typingEl);
    scrollToBottom(true);
  }

  function hideTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  // ---- Restore from Storage ----
  function restoreChat() {
    var messages = Storage.getMessages();
    if (messages.length === 0) {
      showEmptyIfNeeded();
      return;
    }

    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      addMessageDOM(m.role, m.content, {
        restored: true,
        demo: m.demoMode,
      });
    }

    // Force scroll to bottom on restore
    requestAnimationFrame(function () {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    // Mark pill as active if there are messages
    activatePill();
  }

  // ---- Send Logic ----
  function doSend() {
    var query = chatInput.value.trim();

    // Guard: empty
    if (!query) return;

    // Guard: already sending
    if (sending) return;

    activatePill();

    var apiUrl = window.__HEALTHIQ_API;
    if (!apiUrl || window.__healthiq_apiStatus !== 'connected') {
      addMessageDOM('assistant', 'Cannot reach the server. Please start the backend (npm run dev).', { error: true, forceScroll: true });
      Storage.addMessage('assistant', 'Cannot reach the server. Please start the backend (npm run dev).', false);
      return;
    }

    // Render user message
    addMessageDOM('user', query, { forceScroll: true });
    Storage.addMessage('user', query, false);

    chatInput.value = '';
    chatInput.style.height = 'auto';
    setInputEnabled(false);
    showTyping();

    // Timeout controller
    var timedOut = false;
    var timeoutId = setTimeout(function () {
      timedOut = true;
      hideTyping();
      var errMsg = 'Request timed out after 30 seconds. The AI service may be slow or unreachable.';
      addMessageDOM('assistant', errMsg, { error: true, forceScroll: true });
      Storage.addMessage('assistant', errMsg, false);
      setInputEnabled(true);
    }, 30000);

    fetch(apiUrl + '/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: window.__healthiq_deviceUserId || 'anonymous', message: query }),
    })
    .then(function (r) {
      if (!r.ok) throw new Error('Server returned ' + r.status);
      return r.text();
    })
    .then(function (text) {
      if (timedOut) return;
      clearTimeout(timeoutId);
      hideTyping();

      // Guard: malformed JSON
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        var parseErr = 'Received invalid response from server.';
        addMessageDOM('assistant', parseErr, { error: true, forceScroll: true });
        Storage.addMessage('assistant', parseErr, false);
        return;
      }

      if (data.error) {
        addMessageDOM('assistant', data.error, { error: true, forceScroll: true });
        Storage.addMessage('assistant', data.error, false);
        return;
      }

      // Check demo fallback
      var isDemo = data.DEMO_FALLBACK === true ||
        (typeof data.reply === 'string' && data.reply.indexOf('(Demo)') === 0);

      if (isDemo && demoNotice) {
        demoNotice.style.display = 'block';
      }

      var reply = data.reply || 'No response received.';
      addMessageDOM('assistant', reply, {
        demo: isDemo,
        disclaimer: data.disclaimer || null,
        forceScroll: true,
      });
      Storage.addMessage('assistant', reply, isDemo);
    })
    .catch(function (err) {
      if (timedOut) return;
      clearTimeout(timeoutId);
      hideTyping();
      var catchErr = 'Failed to reach AI: ' + (err.message || 'Unknown error');
      addMessageDOM('assistant', catchErr, { error: true, forceScroll: true });
      Storage.addMessage('assistant', catchErr, false);
    })
    .finally(function () {
      if (!timedOut) {
        setInputEnabled(true);
      }
    });
  }

  // ---- Clear Chat Modal ----
  function openModal() {
    if (modalOverlay) {
      modalOverlay.style.display = 'flex';
    }
  }

  function closeModal() {
    if (modalOverlay) {
      modalOverlay.style.display = 'none';
    }
  }

  function confirmClear() {
    closeModal();
    Storage.clearMessages();
    clearChatHistory();
    showEmptyIfNeeded();

    if (demoNotice) demoNotice.style.display = 'none';

    // Reset activation
    if (chatPill) chatPill.classList.remove('chat-active');
    activated = false;
  }

  // ---- Auto-resize textarea ----
  chatInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 130) + 'px';
  });

  // ---- Input bar focus state ----
  var inputBar = document.getElementById('chatInputBar');
  if (inputBar) {
    chatInput.addEventListener('focus', function () {
      inputBar.classList.add('input-focused');
    });
    chatInput.addEventListener('blur', function () {
      inputBar.classList.remove('input-focused');
    });
  }

  // ---- Event Bindings ----
  sendBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      doSend();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function (e) {
      e.preventDefault();
      // Only show modal if there are messages
      if (Storage.getMessageCount() > 0) {
        openModal();
      }
    });
  }

  if (modalCancel) {
    modalCancel.addEventListener('click', function (e) {
      e.preventDefault();
      closeModal();
    });
  }

  if (modalConfirm) {
    modalConfirm.addEventListener('click', function (e) {
      e.preventDefault();
      confirmClear();
    });
  }

  // Close modal on overlay click
  if (modalOverlay) {
    modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) closeModal();
    });
  }

  // Close modal on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalOverlay && modalOverlay.style.display === 'flex') {
      closeModal();
    }
  });

  // ---- Initialize ----
  restoreChat();
})();
