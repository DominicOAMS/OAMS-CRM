/*
 * Tiny local drop-in for the subset of the SweetAlert2 API this app uses — replaces
 * the ~70KB CDN library with a self-contained modal (no external request, works
 * offline, faster load). Implements: Swal.fire (object form + (title,text,icon) form),
 * showLoading, close, showValidationMessage, DismissReason, and inputs text/number/
 * select/file with inputValidator, preConfirm, buttons, footer, timer.
 */
(function () {
  var current = null; // { overlay, resolve, opts, validationShown, timer }

  var Reason = { cancel: 'cancel', close: 'close', esc: 'esc', backdrop: 'backdrop', timer: 'timer' };

  var ICONS = {
    success: { sym: '✓', cls: 'success' },
    error: { sym: '✕', cls: 'error' },
    warning: { sym: '!', cls: 'warning' },
    info: { sym: 'i', cls: 'info' },
    question: { sym: '?', cls: 'question' }
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function settle(result) {
    if (!current) return;
    var c = current;
    current = null;
    if (c.timer) clearTimeout(c.timer);
    if (c.revealTimer) clearTimeout(c.revealTimer); // pending loader that never got shown
    document.removeEventListener('keydown', c.onKey, true);
    if (c.overlay && c.overlay.parentNode) c.overlay.parentNode.removeChild(c.overlay);
    c.resolve(Object.assign({ isConfirmed: false, isDenied: false, isDismissed: false, value: undefined, dismiss: undefined }, result));
  }

  function dismiss(reason) { settle({ isDismissed: true, dismiss: reason }); }

  function readInputValue(opts, popup) {
    if (!opts.input) return undefined;
    var field = popup.querySelector('.swal2-input, .swal2-select, .swal2-file');
    if (!field) return undefined;
    if (opts.input === 'file') return (field.files && field.files[0]) || null;
    return field.value;
  }

  function doConfirm() {
    if (!current) return;
    var opts = current.opts, popup = current.overlay.querySelector('.swal2-popup');
    var value = readInputValue(opts, popup);

    if (typeof opts.inputValidator === 'function') {
      var msg = opts.inputValidator(value);
      if (msg) { Swal.showValidationMessage(msg); return; }
    }

    if (typeof opts.preConfirm === 'function') {
      current.validationShown = false;
      var res = opts.preConfirm(value);
      var finish = function (out) {
        if (current && current.validationShown) return;      // validation blocked it
        if (out === false) return;                            // explicit veto
        settle({ isConfirmed: true, value: (out !== undefined ? out : value) });
      };
      if (res && typeof res.then === 'function') { res.then(finish); return; }
      finish(res);
      return;
    }
    settle({ isConfirmed: true, value: value });
  }

  function buildButton(label, cls, color) {
    var b = el('button', 'swal2-styled ' + cls, label);
    b.type = 'button';
    if (color) b.style.backgroundColor = color;
    return b;
  }

  function fire(a, b, c) {
    var opts = (typeof a === 'string' || a == null) ? { title: a, text: b, icon: c } : (a || {});

    // Replacing an open popup resolves the old one as a plain dismissal (dismiss
    // undefined — NOT 'close', which some callers check for).
    if (current) settle({ isDismissed: true });

    return new Promise(function (resolve) {
      var overlay = el('div', 'swal2-overlay');
      var popup = el('div', 'swal2-popup');
      if (opts.width) popup.style.width = typeof opts.width === 'number' ? opts.width + 'px' : opts.width;

      if (opts.showCloseButton) {
        var x = el('button', 'swal2-close', '×'); x.type = 'button';
        x.addEventListener('click', function () { dismiss(Reason.close); });
        popup.appendChild(x);
      }
      if (opts.icon && ICONS[opts.icon]) {
        popup.appendChild(el('div', 'swal2-icon swal2-icon-' + ICONS[opts.icon].cls, '<span>' + ICONS[opts.icon].sym + '</span>'));
      }
      if (opts.title) popup.appendChild(el('h2', 'swal2-title', opts.title));
      if (opts.html != null) popup.appendChild(el('div', 'swal2-html-container', opts.html));
      else if (opts.text) popup.appendChild(el('div', 'swal2-html-container', document.createTextNode(opts.text).textContent));

      // Input
      if (opts.input) {
        if (opts.inputLabel) popup.appendChild(el('label', 'swal2-input-label', opts.inputLabel));
        var field;
        if (opts.input === 'select') {
          field = el('select', 'swal2-select');
          if (opts.inputPlaceholder) {
            var ph = el('option', null, opts.inputPlaceholder); ph.value = ''; ph.disabled = true; ph.selected = true;
            field.appendChild(ph);
          }
          var io = opts.inputOptions || {};
          Object.keys(io).forEach(function (k) { var o = el('option', null, io[k]); o.value = k; field.appendChild(o); });
        } else if (opts.input === 'file') {
          field = el('input', 'swal2-file'); field.type = 'file';
        } else {
          field = el('input', 'swal2-input'); field.type = (opts.input === 'number') ? 'number' : 'text';
          if (opts.inputValue != null) field.value = opts.inputValue;
          if (opts.inputPlaceholder) field.placeholder = opts.inputPlaceholder;
        }
        if (opts.inputAttributes) Object.keys(opts.inputAttributes).forEach(function (k) { field.setAttribute(k, opts.inputAttributes[k]); });
        field.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && opts.input !== 'file') { ev.preventDefault(); doConfirm(); } });
        popup.appendChild(field);
      }

      popup.appendChild(el('div', 'swal2-validation-message'));

      // Actions
      var actions = el('div', 'swal2-actions');
      var showConfirm = opts.showConfirmButton !== false;
      if (showConfirm) {
        var confirmBtn = buildButton(opts.confirmButtonText || 'OK', 'swal2-confirm', opts.confirmButtonColor);
        confirmBtn.addEventListener('click', doConfirm);
        actions.appendChild(confirmBtn);
      }
      if (opts.showDenyButton) {
        var denyBtn = buildButton(opts.denyButtonText || 'No', 'swal2-deny', opts.denyButtonColor);
        denyBtn.addEventListener('click', function () { settle({ isDenied: true }); });
        actions.appendChild(denyBtn);
      }
      if (opts.showCancelButton) {
        var cancelBtn = buildButton(opts.cancelButtonText || 'Cancel', 'swal2-cancel', opts.cancelButtonColor);
        cancelBtn.addEventListener('click', function () { dismiss(Reason.cancel); });
        actions.appendChild(cancelBtn);
      }
      if (actions.childNodes.length) popup.appendChild(actions);

      if (opts.footer) popup.appendChild(el('div', 'swal2-footer', opts.footer));

      overlay.appendChild(popup);
      if (opts.allowOutsideClick !== false) {
        overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) dismiss(Reason.backdrop); });
      }

      var onKey = function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); dismiss(Reason.esc); } };
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(overlay);
      current = { overlay: overlay, resolve: resolve, opts: opts, validationShown: false, timer: null, onKey: onKey };

      // Focus + timer + didOpen
      var focusEl = popup.querySelector('.swal2-input, .swal2-select, .swal2-file') || popup.querySelector('.swal2-confirm');
      if (focusEl) { try { focusEl.focus(); if (focusEl.select) focusEl.select(); } catch (e) {} }
      if (opts.timer) current.timer = setTimeout(function () { dismiss(Reason.timer); }, opts.timer);
      if (typeof opts.didOpen === 'function') { try { opts.didOpen(popup); } catch (e) {} }

      // Anti-flash: a pure loading modal (showLoading called in didOpen) stays hidden
      // for a moment. Fast local actions close before it ever appears, so tab switches
      // and quick saves show no spinner at all; only a genuinely slow op reveals it.
      if (current && current.isLoading) {
        overlay.style.display = 'none';
        current.revealTimer = setTimeout(function () {
          if (current) overlay.style.display = 'flex';
        }, 400);
      }
    });
  }

  var Swal = {
    fire: fire,
    close: function () { settle({ isDismissed: true }); },
    showLoading: function () {
      if (!current) return;
      current.isLoading = true;
      var popup = current.overlay.querySelector('.swal2-popup');
      var actions = popup.querySelector('.swal2-actions');
      if (actions) actions.style.display = 'none';
      var field = popup.querySelector('.swal2-input, .swal2-select, .swal2-file');
      if (field) field.style.display = 'none';
      if (!popup.querySelector('.swal2-loader')) popup.appendChild(el('div', 'swal2-loader'));
    },
    showValidationMessage: function (msg) {
      if (!current) return;
      current.validationShown = true;
      var box = current.overlay.querySelector('.swal2-validation-message');
      if (box) { box.textContent = msg; box.style.display = 'block'; }
    },
    DismissReason: Reason
  };

  window.Swal = Swal;
})();
