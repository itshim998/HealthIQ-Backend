/* ==========================================================
   HEALTHIQ — CHAT STORAGE (localStorage Persistence)
   Single-responsibility module: CRUD for chat messages.
   No DOM access. No UI logic. Pure data layer.
   ========================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'healthiq_chat_history_v1';
  var MAX_MESSAGES = 200;

  // ---- Helpers ----
  function generateId() {
    // Compact unique ID: timestamp + random suffix
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function isValidMessage(msg) {
    return (
      msg &&
      typeof msg === 'object' &&
      typeof msg.id === 'string' &&
      (msg.role === 'user' || msg.role === 'assistant') &&
      typeof msg.content === 'string' &&
      typeof msg.timestamp === 'number'
    );
  }

  // ---- Core Read ----
  function loadMessages() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];

      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        // Corrupt data — wipe and return empty
        localStorage.removeItem(STORAGE_KEY);
        return [];
      }

      // Filter out any malformed entries
      var valid = [];
      for (var i = 0; i < parsed.length; i++) {
        if (isValidMessage(parsed[i])) {
          valid.push(parsed[i]);
        }
      }

      // Enforce cap
      if (valid.length > MAX_MESSAGES) {
        valid = valid.slice(valid.length - MAX_MESSAGES);
      }

      return valid;
    } catch (e) {
      // JSON parse failure or localStorage blocked
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      return [];
    }
  }

  // ---- Core Write ----
  function saveMessages(messages) {
    try {
      // Enforce cap before save
      var toSave = messages;
      if (toSave.length > MAX_MESSAGES) {
        toSave = toSave.slice(toSave.length - MAX_MESSAGES);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      return true;
    } catch (e) {
      // Storage quota exceeded — trim older half and retry once
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        try {
          var trimmed = messages.slice(Math.floor(messages.length / 2));
          localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    }
  }

  // ---- Public API ----
  function addMessage(role, content, demoMode) {
    var messages = loadMessages();
    var msg = {
      id: generateId(),
      role: role,
      content: content,
      timestamp: Date.now(),
      demoMode: !!demoMode,
    };

    messages.push(msg);
    saveMessages(messages);
    return msg;
  }

  function getMessages() {
    return loadMessages();
  }

  function clearMessages() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function getMessageCount() {
    return loadMessages().length;
  }

  // ---- Expose on window ----
  window.HealthIQChatStorage = {
    addMessage: addMessage,
    getMessages: getMessages,
    clearMessages: clearMessages,
    getMessageCount: getMessageCount,
    MAX_MESSAGES: MAX_MESSAGES,
  };
})();
