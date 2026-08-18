/*
 * google.script.run shim — lets the existing Apps Script front-end run unchanged.
 * Any google.script.run.withSuccessHandler(cb).withFailureHandler(eb).fnName(args)
 * chain becomes a POST to /api/rpc {fn, args} and dispatches to the Flask backend.
 */
(function () {
  function makeRunner() {
    var handlers = { success: null, failure: null };
    var proxy = new Proxy({}, {
      get: function (t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'withSuccessHandler') return function (fn) { handlers.success = fn; return proxy; };
        if (prop === 'withFailureHandler') return function (fn) { handlers.failure = fn; return proxy; };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: prop, args: args })
          })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res && res.ok) { if (handlers.success) handlers.success(res.result); }
              else if (handlers.failure) handlers.failure(new Error(res && res.error ? res.error : 'Request failed'));
            })
            .catch(function (err) { if (handlers.failure) handlers.failure(err); });
        };
      }
    });
    return proxy;
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', { get: makeRunner });
})();

  window.currentView = 'Home';
  window.currentTableData = { columns: [], rows: [] };
  // ID columns (Lead ID, Account ID, Contact ID, Deal ID, ...) are never shown in the
  // UI. They still exist in the sheets and in window.currentTableData for internal
  // addressing (Add Contact, Log Visit, Attachments) - only the rendering skips them.
  const HIDE_IDS = true;

  // Search/filter state for the table views (Leads/Contacts/Accounts). Reset on tab
  // switch; applied by renderTableRows without renumbering rows.
  let tableSearch = '';
  let tableFilterCol = '';
  let tableFilterVal = '';
  let tableSortCol = '';
  let tableSortDir = ''; // 'asc' | 'desc' | '' (unsorted)
  // Set by "View Contacts" on an Account row, consumed once the Contacts tab's data
  // has actually loaded (setting the filter before then would just get overwritten).
  let pendingTableFilter = null;
  // Same idea, for jumping from a Home dashboard row into a pre-searched table.
  let pendingTableSearch = null;
  // Same idea again, for running a follow-up action (e.g. opening Log Visit) once the
  // target tab's data has actually loaded.
  let pendingTableAction = null;

  document.addEventListener('DOMContentLoaded', () => switchTab('Home'));

  // Mobile sidebar: off-canvas below the CSS breakpoint, toggled by the hamburger
  // button and closed by the backdrop or by picking a nav item.
  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('show');
  }
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('sidebarToggle');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (toggle) toggle.addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
      backdrop.classList.toggle('show');
    });
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
  });

  // Click-and-drag panning for the (already touch-scrollable) data table, for mouse
  // users who wouldn't otherwise know to shift+scroll or hunt for the scrollbar.
  document.addEventListener('DOMContentLoaded', () => {
    const scroller = document.querySelector('.table-scroll');
    if (!scroller) return;
    let isDown = false, dragged = false, startX = 0, startScroll = 0;

    scroller.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // left button only
      isDown = true;
      dragged = false;
      startX = e.pageX;
      startScroll = scroller.scrollLeft;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      const dx = e.pageX - startX;
      if (!dragged && Math.abs(dx) < 4) return; // small threshold so plain clicks pass through
      dragged = true;
      scroller.classList.add('dragging');
      scroller.scrollLeft = startScroll - dx;
    });

    window.addEventListener('mouseup', () => {
      isDown = false;
      scroller.classList.remove('dragging');
    });

    // A capturing listener on the scroller (an ancestor of every cell) runs before any
    // cell's own onclick - stopping it here is what keeps a drag from also opening the
    // cell editor underneath the cursor on mouseup.
    scroller.addEventListener('click', (e) => {
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
      }
      dragged = false;
    }, true);
  });

  // Always-visible custom scrollbar for the table (native scrollbars auto-hide on
  // touch/Mac, which made the horizontal overflow hard to discover) - a thin track +
  // draggable thumb underneath the table, plus explicit left/right buttons.
  function syncTableScrollbar() {
    const scroller = document.querySelector('.table-scroll');
    const track = document.getElementById('tableScrollbarTrack');
    const thumb = document.getElementById('tableScrollbarThumb');
    if (!scroller || !track || !thumb) return;

    const trackWidth = track.clientWidth;
    const contentWidth = scroller.scrollWidth;
    const viewWidth = scroller.clientWidth;
    if (contentWidth <= viewWidth || trackWidth === 0) {
      // Nothing to scroll - fill the track so it visually reads as "all the way".
      thumb.style.width = '100%';
      thumb.style.left = '0';
      return;
    }
    const thumbWidth = Math.max(30, (viewWidth / contentWidth) * trackWidth);
    const maxThumbLeft = trackWidth - thumbWidth;
    const maxScroll = contentWidth - viewWidth;
    const thumbLeft = maxScroll > 0 ? (scroller.scrollLeft / maxScroll) * maxThumbLeft : 0;
    thumb.style.width = thumbWidth + 'px';
    thumb.style.left = thumbLeft + 'px';
  }

  document.addEventListener('DOMContentLoaded', () => {
    const scroller = document.querySelector('.table-scroll');
    const track = document.getElementById('tableScrollbarTrack');
    const thumb = document.getElementById('tableScrollbarThumb');
    const leftBtn = document.getElementById('tableScrollLeftBtn');
    const rightBtn = document.getElementById('tableScrollRightBtn');
    if (!scroller || !track || !thumb || !leftBtn || !rightBtn) return;

    scroller.addEventListener('scroll', syncTableScrollbar);
    window.addEventListener('resize', syncTableScrollbar);

    leftBtn.addEventListener('click', () => scroller.scrollBy({ left: -200, behavior: 'smooth' }));
    rightBtn.addEventListener('click', () => scroller.scrollBy({ left: 200, behavior: 'smooth' }));

    // Clicking the track (not the thumb itself) jumps the scroll position there.
    track.addEventListener('click', (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      scroller.scrollLeft = ratio * maxScroll;
    });

    // Dragging the thumb scrolls the table proportionally - mirrors the table's own
    // click-and-drag panning, just anchored to the visible scrollbar instead.
    let dragging = false, startX = 0, startScrollLeft = 0;
    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.pageX;
      startScrollLeft = scroller.scrollLeft;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const trackWidth = track.clientWidth;
      const contentWidth = scroller.scrollWidth;
      const viewWidth = scroller.clientWidth;
      const thumbWidth = Math.max(30, (viewWidth / contentWidth) * trackWidth);
      const maxThumbLeft = trackWidth - thumbWidth;
      const maxScroll = contentWidth - viewWidth;
      if (maxThumbLeft <= 0 || maxScroll <= 0) return;
      const dx = e.pageX - startX;
      const scrollDelta = (dx / maxThumbLeft) * maxScroll;
      scroller.scrollLeft = startScrollLeft + scrollDelta;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  });

  // Minimal HTML-escaping for the new innerHTML-building code in this file (Kanban
  // cards, dynamic forms, attachments, analytics). The pre-existing table rendering
  // below does not escape cell values either - this doesn't retrofit that, it just
  // avoids adding new unescaped interpolation alongside it.
  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Columns like "Contact ID"/"Account ID" are real data (needed for the Account
  // dropdown link, row identification, etc.) but not what a user is scanning a table
  // for - dim/shrink them in the UI rather than hide them.
  function isIdColumn(name) {
    return /\bid$/i.test((name || '').toString().trim());
  }

  // Reps type dates free-hand ("july72026", "june 2 2025", "07/02/2026") and expect
  // them to land in one consistent format - otherwise the same field ends up with a
  // mix of styles that sort/compare inconsistently. Detected by column name so it
  // applies wherever a date-shaped field shows up (Date of Last Visit, Closed Date,
  // Visit Date, Date of Birth, Next Follow-up) without needing a schema-wide "type".
  function isDateColumnName(name) {
    return /date|follow-?up/i.test((name || '').toString());
  }

  const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

  function isoDateFromParts(yearStr, month, dayStr) {
    let year = parseInt(yearStr, 10);
    if (yearStr.length === 2) year += (year < 70 ? 2000 : 1900);
    const mo = parseInt(month, 10);
    const day = parseInt(dayStr, 10);
    if (!year || mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${year}-${pad(mo)}-${pad(day)}`;
  }

  // Best-effort loose date parser - returns "YYYY-MM-DD" on success, or null if the
  // text isn't recognizable as a date (caller then leaves the original text alone
  // rather than clobbering something that wasn't meant to be a date).
  function parseLooseDate(input) {
    const s = (input || '').toString().trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const lower = s.toLowerCase();

    for (let i = 0; i < MONTH_NAMES.length; i++) {
      const full = MONTH_NAMES[i], abbr = full.slice(0, 3);
      const namePattern = `(?:${full}|${abbr})`;
      const monthNum = i + 1;

      // "july 7 2026", "july7,2026", "jul. 7 2026"
      let m = lower.match(new RegExp(`^${namePattern}[\\s,.]*(\\d{1,2})[\\s,.]+(\\d{2,4})$`));
      if (m) return isoDateFromParts(m[2], monthNum, m[1]);

      // "7 july 2026"
      m = lower.match(new RegExp(`^(\\d{1,2})[\\s,.]*${namePattern}[\\s,.]+(\\d{2,4})$`));
      if (m) return isoDateFromParts(m[2], monthNum, m[1]);

      // "july72026" - day and year run together with no separator; assume a 4-digit
      // year and whatever digits are left (1 or 2) are the day.
      m = lower.match(new RegExp(`^${namePattern}(\\d{5,6})$`));
      if (m) {
        const digits = m[1];
        const day = digits.length === 5 ? digits.slice(0, 1) : digits.slice(0, 2);
        const year = digits.length === 5 ? digits.slice(1) : digits.slice(2);
        return isoDateFromParts(year, monthNum, day);
      }
    }

    // Numeric formats: "2026-7-2", "07/02/2026", "7-2-26"
    const m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
    if (m) {
      const [, a, b, c] = m;
      if (a.length === 4) return isoDateFromParts(a, b, c);
      if (c.length === 2 || c.length === 4) {
        let month = a, day = b;
        if (parseInt(a, 10) > 12 && parseInt(b, 10) <= 12) { month = b; day = a; }
        return isoDateFromParts(c, month, day);
      }
    }

    return null;
  }

  // Applied at every point a user types into a date-shaped field (table cells, the
  // inline add-row, the Record Profile, and the Add Contact/New Deal modals) so the
  // stored value is consistent no matter which of those a rep used.
  function normalizeDateInput(colName, value) {
    if (!isDateColumnName(colName)) return value;
    const parsed = parseLooseDate(value);
    return parsed === null ? value : parsed;
  }

  // --- TAB SWITCHING ---
  window.switchTab = function(viewName) {
    window.currentView = viewName;
    document.getElementById('page-title').innerText = viewName;

    // Update sidebar UI
    document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
    const activeTab = document.getElementById('nav-' + viewName);
    if (activeTab) activeTab.classList.add('active');
    closeSidebar(); // no-op on desktop widths, closes the off-canvas menu on mobile

    showViewContainer(viewName);
    resetTableFilters(); // a fresh tab starts unfiltered

    if (viewName === 'Home') {
      loadHome();
    } else if (viewName === 'Deals') {
      loadDealsBoard();
    } else if (viewName === 'Analytics') {
      loadAnalytics();
    } else if (viewName === 'Documents') {
      loadDocuments(null);
    } else if (viewName === 'Users') {
      loadUsers();
    } else if (viewName === 'MyTasks') {
      loadMyTasks();
    } else if (viewName === 'Calendar') {
      loadCalendar();
    } else {
      loadData(viewName);
    }
  };

  function showViewContainer(viewName) {
    const isTableView = (viewName === 'Leads' || viewName === 'Contacts' || viewName === 'Accounts' || viewName === 'Products');

    document.querySelector('.data-table').style.display = isTableView ? '' : 'none';
    document.getElementById('homeView').style.display = viewName === 'Home' ? 'block' : 'none';
    document.getElementById('dealsKanbanView').style.display = viewName === 'Deals' ? 'flex' : 'none';
    document.getElementById('analyticsView').style.display = viewName === 'Analytics' ? 'block' : 'none';
    document.getElementById('documentsView').style.display = viewName === 'Documents' ? 'block' : 'none';
    document.getElementById('myTasksView').style.display = viewName === 'MyTasks' ? 'block' : 'none';
    document.getElementById('calendarView').style.display = viewName === 'Calendar' ? 'block' : 'none';
    // usersView only exists in the DOM for admins (the tab's Jinja block is skipped
    // entirely for everyone else), so guard before touching it.
    const usersView = document.getElementById('usersView');
    if (usersView) usersView.style.display = viewName === 'Users' ? 'block' : 'none';

    // Contextual top-bar buttons: only the ones relevant to the active view show.
    document.getElementById('newDealBtn').style.display = viewName === 'Deals' ? 'inline-block' : 'none';
    document.getElementById('newFolderBtn').style.display = viewName === 'Documents' ? 'inline-block' : 'none';
    document.getElementById('uploadDocBtn').style.display = viewName === 'Documents' ? 'inline-block' : 'none';
    const addUserBtn = document.getElementById('addUserBtn');
    if (addUserBtn) addUserBtn.style.display = viewName === 'Users' ? 'inline-block' : 'none';
    // Manage Columns / Import Data only make sense for the spreadsheet-backed tables.
    document.getElementById('manageColumnsBtn').style.display = isTableView ? 'inline-block' : 'none';
    document.getElementById('importBtn').style.display = isTableView ? 'inline-block' : 'none';
    const newRecordBtn = document.getElementById('newRecordBtn');
    newRecordBtn.style.display = isTableView ? 'inline-block' : 'none';
    if (isTableView) newRecordBtn.textContent = '+ New ' + NEW_RECORD_LABEL[viewName];
    // Export covers Deals too (unlike Import/New/Manage Columns) - it has no table UI
    // of its own, but its data is exactly as exportable as any spreadsheet-backed tab.
    document.getElementById('exportBtn').style.display = (isTableView || viewName === 'Deals') ? 'inline-block' : 'none';
    document.getElementById('tableToolbar').style.display = isTableView ? 'flex' : 'none';
    document.getElementById('tableFooter').style.display = isTableView ? 'flex' : 'none';
    document.getElementById('kanbanToolbar').style.display = viewName === 'Deals' ? 'flex' : 'none';
  }

  function loadData(viewName) {
    Swal.fire({
      title: `Loading ${viewName}...`,
      allowOutsideClick: false,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => { Swal.showLoading(); }
    });
    google.script.run
      .withSuccessHandler(data => {
        Swal.close();
        renderTable(data);
      })
      .withFailureHandler(err => {
        Swal.fire('Error', err.message, 'error');
      })
      .getSheetData(viewName);
  }

  function renderTable(data) {
    window.currentTableData = data;
    if (pendingTableFilter && pendingTableFilter.view === window.currentView) {
      tableFilterCol = pendingTableFilter.col;
      tableFilterVal = pendingTableFilter.val;
      pendingTableFilter = null;
    }
    if (pendingTableSearch && pendingTableSearch.view === window.currentView) {
      tableSearch = pendingTableSearch.query;
      const searchInput = document.getElementById('tableSearch');
      if (searchInput) searchInput.value = tableSearch;
      pendingTableSearch = null;
    }
    populateFilterColumnDropdown(data);
    renderTableRows();
    if (pendingTableAction && pendingTableAction.view === window.currentView) {
      const action = pendingTableAction;
      pendingTableAction = null;
      action.run(data);
    }
  }

  // Rebuilds just the header + body from window.currentTableData, applying the current
  // search/filter. Split out from renderTable so typing in the search box re-renders
  // rows without rebuilding (and losing) the filter dropdowns.
  function renderTableRows() {
    const data = window.currentTableData;
    const thead = document.querySelector('.data-table thead');
    const tbody = document.querySelector('.data-table tbody');

    // Render Headers with pinned action column. Every visible header is clickable to
    // sort by that column (asc -> desc -> unsorted); the current sort shows a ▲/▼.
    let headerHtml = '<tr><th class="sticky-col">⚡</th>';
    let visibleColCount = 0;
    data.columns.forEach(col => {
      if (HIDE_IDS && isIdColumn(col.name)) return;
      visibleColCount++;
      const sortArrow = tableSortCol === col.name ? (tableSortDir === 'asc' ? ' <span class="sort-arrow">\u25B2</span>' : ' <span class="sort-arrow">\u25BC</span>') : '';
      const safeName = col.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      headerHtml += `<th class="sortable-col${isIdColumn(col.name) ? ' col-id' : ''}" onclick="toggleSort('${safeName}')">${col.name}${sortArrow}</th>`;
    });
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;

    // Render Data Rows (Inline Editing + Action Menu). Rows that don't match the search
    // /filter are SKIPPED, not renumbered - rowIndex stays the true index so editing,
    // delete, convert, etc. keep pointing at the right sheet row. Sorting reorders which
    // rowIndex is visited first, but never changes what rowIndex means, so actions still
    // land on the right record.
    let rowIndices = [];
    data.rows.forEach((row, rowIndex) => {
      if (isRowBlank(row, data.columns)) return;
      if (!rowMatchesFilters(row, data.columns)) return;
      rowIndices.push(rowIndex);
    });

    if (tableSortCol) {
      const sortColIdx = data.columns.findIndex(c => c.name === tableSortCol);
      if (sortColIdx > -1) {
        rowIndices.sort((ai, bi) => {
          const av = data.rows[ai][sortColIdx];
          const bv = data.rows[bi][sortColIdx];
          const aBlank = av === null || av === undefined || String(av).trim() === '';
          const bBlank = bv === null || bv === undefined || String(bv).trim() === '';
          if (aBlank && bBlank) return 0;
          if (aBlank) return 1;  // blanks always last, regardless of sort direction
          if (bBlank) return -1;
          return compareCells(av, bv) * (tableSortDir === 'desc' ? -1 : 1);
        });
      }
    }

    let bodyHtml = '';
    let matchCount = rowIndices.length;
    rowIndices.forEach(rowIndex => {
      const row = data.rows[rowIndex];
      bodyHtml += `<tr>`;

      // Pinned Action Column
      bodyHtml += `<td class="sticky-col">
        <div class="action-dropdown">
          <button class="action-btn" onclick="toggleActionMenu(event, ${rowIndex})">⋮</button>
          <div id="action-menu-${rowIndex}" class="action-menu-content">`;
          
          if (window.currentView === 'Leads') {
            bodyHtml += `<a href="#" onclick="promptConvertLead(event, ${rowIndex})">Convert Lead</a>`;
            bodyHtml += `<a href="#" onclick="openRecordProfile(event, ${rowIndex})">View Profile</a>`;
            bodyHtml += `<a href="#" onclick="openTasksModalForRow(event, ${rowIndex})">Tasks</a>`;
          } else if (window.currentView === 'Accounts') {
            bodyHtml += `<a href="#" onclick="promptLogVisit(event, ${rowIndex})">Log Visit</a>`;
            bodyHtml += `<a href="#" onclick="openVisitsModal(event, ${rowIndex})">View Visits</a>`;
            bodyHtml += `<a href="#" onclick="promptAddContact(event, ${rowIndex})">Add Contact</a>`;
            bodyHtml += `<a href="#" onclick="viewContactsForAccount(event, ${rowIndex})">View Contacts</a>`;
            bodyHtml += `<a href="#" onclick="openRecordProfile(event, ${rowIndex})">View Profile</a>`;
            bodyHtml += `<a href="#" onclick="openTasksModalForRow(event, ${rowIndex})">Tasks</a>`;
          } else if (window.currentView === 'Contacts') {
            bodyHtml += `<a href="#" onclick="openRecordProfile(event, ${rowIndex})">View Profile</a>`;
            bodyHtml += `<a href="#" onclick="openTasksModalForRow(event, ${rowIndex})">Tasks</a>`;
          }

          const needsMenuDivider = (window.currentView === 'Leads' || window.currentView === 'Accounts' || window.currentView === 'Contacts');
      bodyHtml += `<a href="#" onclick="promptDeleteRecord(event, ${rowIndex})" style="color: #d93025; ${needsMenuDivider ? 'border-top: 1px solid #e1e5eb;' : ''}">Delete</a>
          </div>
        </div>
      </td>`;
      
      row.forEach((cell, colIndex) => {
        const col = data.columns[colIndex];
        if (HIDE_IDS && isIdColumn(col.name)) return;
        const idClass = isIdColumn(col.name) ? ' inline-input-id' : '';
        const val = (cell === null || cell === undefined) ? '' : String(cell);
        const empty = val === '';
        // Plain text by default; startCellEdit swaps in an input/select on click.
        bodyHtml += `<td><div class="cell-view${idClass}${empty ? ' empty' : ''}" title="${escapeHtml(val)}" onclick="startCellEdit(this, ${rowIndex}, ${colIndex})">${empty ? '—' : escapeHtml(val)}</div></td>`;
      });
      bodyHtml += '</tr>';
    });

    // Empty state when a search/filter (or blank-row hiding) leaves nothing to show -
    // the add-row still shows below regardless.
    if (matchCount === 0) {
      const msg = (tableSearch || tableFilterVal) ? 'No matching records' : 'No records to display';
      bodyHtml += `<tr><td class="sticky-col"></td><td colspan="${visibleColCount}" style="text-align:center; color:#a0aabf; padding:28px; font-size:13px;">${msg}</td></tr>`;
    }

    tbody.innerHTML = bodyHtml;

    document.getElementById('tableFooterCount').innerText = `Total Records: ${matchCount}`;
    syncTableScrollbar();
  }

  // A row with nothing in any visible column is treated as junk (leftover from a messy
  // import) and hidden - this only affects what's rendered, the underlying record is
  // untouched, so it still exists if you ever need it (e.g. via a raw DB query).
  function isRowBlank(row, columns) {
    return columns.every((col, i) => {
      if (isIdColumn(col.name)) return true;
      const v = row[i];
      return v === null || v === undefined || String(v).trim() === '';
    });
  }

  // --- TABLE SEARCH + FILTER ---
  function rowMatchesFilters(row, columns) {
    if (tableSearch) {
      const q = tableSearch.toLowerCase();
      const hit = row.some(cell => String(cell === null || cell === undefined ? '' : cell).toLowerCase().indexOf(q) > -1);
      if (!hit) return false;
    }
    if (tableFilterCol && tableFilterVal) {
      const ci = columns.findIndex(c => c.name === tableFilterCol);
      // Case-insensitive so "BATANGAS" matches a "Batangas" filter selection.
      if (ci > -1 && String(row[ci]).toLowerCase() !== String(tableFilterVal).toLowerCase()) return false;
    }
    return true;
  }

  function populateFilterColumnDropdown(data) {
    const fc = document.getElementById('filterColumn');
    const cols = data.columns.filter(c => !isIdColumn(c.name));
    // Drop a stale filter if its column no longer exists on this table.
    if (tableFilterCol && !cols.some(c => c.name === tableFilterCol)) {
      tableFilterCol = ''; tableFilterVal = '';
    }
    let html = '<option value="">Filter by...</option>';
    cols.forEach(c => {
      html += `<option value="${escapeHtml(c.name)}"${c.name === tableFilterCol ? ' selected' : ''}>${escapeHtml(c.name)}</option>`;
    });
    fc.innerHTML = html;
    if (tableFilterCol) populateFilterValueDropdown(data);
    else document.getElementById('filterValue').style.display = 'none';
    updateClearBtn();
  }

  function populateFilterValueDropdown(data) {
    const fv = document.getElementById('filterValue');
    const ci = data.columns.findIndex(c => c.name === tableFilterCol);
    // Collapse casing variants (BATANGAS / Batangas) to one option; keep first-seen spelling.
    const seen = {};
    const vals = [];
    if (ci > -1) {
      data.rows.forEach(r => {
        const v = (r[ci] === null || r[ci] === undefined) ? '' : String(r[ci]);
        const k = v.toLowerCase();
        if (v !== '' && !seen[k]) { seen[k] = true; vals.push(v); }
      });
    }
    vals.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    let html = `<option value="">All ${escapeHtml(tableFilterCol)}</option>`;
    vals.forEach(v => {
      html += `<option value="${escapeHtml(v)}"${v === tableFilterVal ? ' selected' : ''}>${escapeHtml(v)}</option>`;
    });
    fv.innerHTML = html;
    fv.style.display = 'inline-flex';
  }

  function updateClearBtn() {
    document.getElementById('clearFiltersBtn').style.display = (tableSearch || tableFilterCol) ? 'inline-flex' : 'none';
  }

  function resetTableFilters() {
    tableSearch = ''; tableFilterCol = ''; tableFilterVal = '';
    tableSortCol = ''; tableSortDir = '';
    const s = document.getElementById('tableSearch'); if (s) s.value = '';
    const fc = document.getElementById('filterColumn'); if (fc) fc.value = '';
    const fv = document.getElementById('filterValue'); if (fv) { fv.innerHTML = ''; fv.style.display = 'none'; }
    const cb = document.getElementById('clearFiltersBtn'); if (cb) cb.style.display = 'none';
  }

  // Cycles a column through asc -> desc -> unsorted on repeated clicks; switching to a
  // different column always starts fresh at asc.
  window.toggleSort = function(colName) {
    if (tableSortCol === colName) {
      tableSortDir = tableSortDir === 'asc' ? 'desc' : (tableSortDir === 'desc' ? '' : 'asc');
      if (tableSortDir === '') tableSortCol = '';
    } else {
      tableSortCol = colName;
      tableSortDir = 'asc';
    }
    renderTableRows();
  };

  // Numeric-aware compare (so "100" sorts before "20", not after, and mixed
  // alphanumeric values like "Row2"/"Row10" order sensibly). Blank handling is the
  // caller's job (blanks are always pushed last regardless of sort direction).
  function compareCells(a, b) {
    const av = String(a === null || a === undefined ? '' : a).trim();
    const bv = String(b === null || b === undefined ? '' : b).trim();
    const an = parseFloat(av.replace(/,/g, ''));
    const bn = parseFloat(bv.replace(/,/g, ''));
    const bothNumeric = !isNaN(an) && !isNaN(bn) && /^-?[\d,]*\.?\d+$/.test(av) && /^-?[\d,]*\.?\d+$/.test(bv);
    if (bothNumeric) return an - bn;
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  }

  document.getElementById('tableSearch').addEventListener('input', (e) => {
    tableSearch = e.target.value.trim();
    updateClearBtn();
    renderTableRows();
  });

  document.getElementById('filterColumn').addEventListener('change', (e) => {
    tableFilterCol = e.target.value;
    tableFilterVal = '';
    if (tableFilterCol) {
      populateFilterValueDropdown(window.currentTableData);
    } else {
      document.getElementById('filterValue').style.display = 'none';
    }
    updateClearBtn();
    renderTableRows();
  });

  document.getElementById('filterValue').addEventListener('change', (e) => {
    tableFilterVal = e.target.value;
    renderTableRows();
  });

  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    resetTableFilters();
    populateFilterColumnDropdown(window.currentTableData);
    renderTableRows();
  });

  // Rebuilds a single cell's read-only view (used to leave edit mode). Kept in sync
  // with the cell markup in renderTable.
  function renderCellView(td, rowIndex, colIndex) {
    const col = window.currentTableData.columns[colIndex];
    const raw = window.currentTableData.rows[rowIndex][colIndex];
    const val = (raw === null || raw === undefined) ? '' : String(raw);
    const empty = val === '';
    const idClass = isIdColumn(col.name) ? ' inline-input-id' : '';

    td.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'cell-view' + idClass + (empty ? ' empty' : '');
    div.title = val;
    div.textContent = empty ? '—' : val;
    div.addEventListener('click', () => startCellEdit(div, rowIndex, colIndex));
    td.appendChild(div);
  }

  // Click a cell to edit it in place: swap the text for an input (or dropdown), commit
  // on blur/Enter, cancel on Escape. Editing existing rows this way keeps the table
  // reading as clean data instead of a grid of form fields.
  window.startCellEdit = function(el, rowIndex, colIndex) {
    const td = el.parentElement;
    const col = window.currentTableData.columns[colIndex];
    const raw = window.currentTableData.rows[rowIndex][colIndex];
    const original = (raw === null || raw === undefined) ? '' : String(raw);

    let editor;
    if (col.type === 'dropdown') {
      editor = document.createElement('select');
      editor.className = 'inline-input';
      const blank = document.createElement('option');
      blank.value = '';
      editor.appendChild(blank);
      (col.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === original) o.selected = true;
        editor.appendChild(o);
      });
    } else if (col.type === 'date') {
      editor = document.createElement('input');
      editor.type = 'date';
      editor.className = 'inline-input';
      editor.value = original;
    } else {
      editor = document.createElement('input');
      editor.type = 'text';
      editor.className = 'inline-input';
      editor.value = original;
    }

    td.innerHTML = '';
    td.appendChild(editor);
    editor.focus();
    if (editor.select) editor.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const newVal = normalizeDateInput(col.name, editor.value);
      window.currentTableData.rows[rowIndex][colIndex] = newVal; // optimistic
      if (newVal !== original) {
        handleExistingDataChange(rowIndex, col.name, newVal);
      }
      renderCellView(td, rowIndex, colIndex);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      renderCellView(td, rowIndex, colIndex);
    };

    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); editor.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    if (col.type === 'dropdown' || col.type === 'date') {
      editor.addEventListener('change', () => editor.blur());
    }
  };

  // --- ACTION MENU LOGIC ---
  // Menus are positioned as position:fixed against the viewport (coords computed on
  // open), NOT absolutely inside their row/card. A Kanban card lives inside a column
  // with overflow scrolling, so an absolutely-positioned menu got clipped at the
  // column edge (the cut-off "M / Ed / De" menu). Fixed positioning escapes every
  // scroll container, and we flip left/up near the screen edges so it always fits.
  //
  // Escaping the scroll container isn't the same as escaping its STACKING CONTEXT,
  // though - the menu's parent <td class="sticky-col"> is itself position:sticky
  // with its own z-index, which makes the td a stacking context. The menu's own
  // z-index:1000 only wins comparisons made *inside* that td; against an unrelated
  // sibling stacking context elsewhere on the page (the table's sticky footer row,
  // the outer scrollbar/record-count bar, a Kanban column) it's the TD'S z-index
  // that actually gets compared, and loses. Tried bumping the td's static z-index
  // once already - it beat one overlapping element but then lost to a *different*
  // one, because these sticky elements have a real, order-dependent relationship
  // with each other in the normal (no menu open) case that a single reshuffled
  // number can't satisfy for every case at once. Fixing it for real: temporarily
  // boost whichever positioned-with-z-index ancestor is trapping the OPEN menu to
  // the max z-index, only while it's open, then put it back - wins against
  // anything, in any container this menu ever ends up in.
  let elevatedAncestors = [];

  function elevateMenuAncestors(menu) {
    const boosted = [];
    let el = menu.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') {
        boosted.push({ el, prevZIndex: el.style.zIndex });
        el.style.zIndex = '2147483647';
      }
      el = el.parentElement;
    }
    return boosted;
  }

  function restoreElevatedAncestors() {
    elevatedAncestors.forEach(({ el, prevZIndex }) => { el.style.zIndex = prevZIndex; });
    elevatedAncestors = [];
  }

  window.toggleActionMenu = function(e, index) {
    e.stopPropagation();
    const menu = document.getElementById('action-menu-' + index);
    if (!menu) return;
    const willShow = !menu.classList.contains('show');
    closeAllActionMenus();
    if (willShow) {
      menu.classList.add('show');
      positionActionMenu(menu, e.currentTarget);
      elevatedAncestors = elevateMenuAncestors(menu);
    }
  };

  function positionActionMenu(menu, button) {
    const btn = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4, margin = 8;

    // Prefer opening to the right of the button; flip left if it would overflow.
    let left = btn.right + gap;
    if (left + menuRect.width > window.innerWidth - margin) {
      left = btn.left - menuRect.width - gap;
    }
    if (left < margin) left = margin;

    // Align to the button top; nudge up if it would run off the bottom.
    let top = btn.top;
    if (top + menuRect.height > window.innerHeight - margin) {
      top = window.innerHeight - menuRect.height - margin;
    }
    if (top < margin) top = margin;

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function closeAllActionMenus() {
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    restoreElevatedAncestors();
  }

  window.onclick = function(e) {
    if (!e.target.matches('.action-btn')) {
      closeAllActionMenus();
    }
  };

  // A fixed-positioned menu won't follow its button when the page/list scrolls, so
  // close any open menu on scroll rather than let it drift away from its row.
  window.addEventListener('scroll', closeAllActionMenus, true);

  window.promptConvertLead = function(e, rowIndex) {
    e.preventDefault();
    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;

    let company = '';
    let name = '';
    let firstName = '';
    let lastName = '';

    columns.forEach((col, idx) => {
      const colLower = col.name.toLowerCase();
      if (colLower === 'company' || colLower === 'account name') company = rowData[idx] || company;
      if (colLower === 'name' || colLower === 'contact person') name = rowData[idx] || name;
      if (colLower === 'first name') firstName = rowData[idx] || firstName;
      if (colLower === 'last name') lastName = rowData[idx] || lastName;
    });
    // This schema (First Name + Last Name, no combined "Name" field) is exactly what
    // this app's real Lead data actually uses - without this, the blank-name check
    // just below would block every single conversion, since `name` would never be set.
    if (!name) name = (firstName + ' ' + lastName).trim();

    // Converting with a blank Company/Name used to silently write permanent
    // "Unknown Company"/"Unknown Name" records - block it instead, since a rep
    // confirming the dialog has no way to tell those are placeholders, not real data.
    if (!company.trim() || !name.trim()) {
      Swal.fire({
        title: 'Missing info',
        text: 'This Lead needs both a Company and a Name filled in before it can be converted.',
        icon: 'warning',
        heightAuto: false,
        scrollbarPadding: false
      });
      return;
    }

    Swal.fire({
      title: 'Convert Lead?',
      html: `This will create:<br><br>
             <div style="text-align: left; display: inline-block; background: #f9fbfd; padding: 15px; border-radius: 4px; border: 1px solid #e1e5eb;">
               <b>Account:</b> ${company}<br>
               <b style="display:inline-block; margin-top:5px;">Contact:</b> ${name}<br>
               <b style="display:inline-block; margin-top:5px;">Deal:</b> ${company} Deal
             </div>
             <p style="margin-top:14px; font-size:13px; color:#5c6673;">This Lead will then be removed from the Leads list - its info lives on in the new Account/Contact/Deal above.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Convert',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Converting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => {
            Swal.close();
            renderTable(data);
            // "Converted!" used to auto-close with no way to actually find what got
            // created - a rep was left on the (now shorter) Leads list having to guess
            // which tab to check. This jumps straight there instead.
            Swal.fire({
              title: 'Converted!',
              text: `${company} is now an Account.`,
              icon: 'success',
              showConfirmButton: true,
              confirmButtonText: 'View Account',
              confirmButtonColor: '#0088ff',
              showCancelButton: true,
              cancelButtonText: 'Close',
              heightAuto: false,
              scrollbarPadding: false
            }).then(viewResult => {
              if (viewResult.isConfirmed) {
                pendingTableFilter = { view: 'Accounts', col: 'Account Name', val: company };
                switchTab('Accounts');
              }
            });
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .convertLeadToAccount(rowIndex);
      }
    });
  };

  window.promptAddContact = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === 'Account ID');
    const nameIdx = columns.findIndex(c => c.name === 'Account Name');
    const accountId = idIdx > -1 ? rowData[idIdx] : null;
    const accountName = nameIdx > -1 ? rowData[nameIdx] : 'this account';

    if (!accountId) { Swal.fire('Error', 'Could not determine the Account ID for this row.', 'error'); return; }

    const CONTACT_SYSTEM_FIELDS = ['Contact ID', 'Account', 'Created Time'];

    Swal.fire({ title: 'Loading...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });

    google.script.run
      .withSuccessHandler(contactsData => {
        Swal.close();
        const contactColumns = contactsData.columns;
        Swal.fire({
          title: `Add Contact to ${accountName}`,
          html: buildDynamicFieldsHtml(contactColumns, CONTACT_SYSTEM_FIELDS, {}),
          showCancelButton: true,
          confirmButtonText: 'Add Contact',
          confirmButtonColor: '#0088ff',
          heightAuto: false,
          scrollbarPadding: false,
          preConfirm: () => readDynamicFieldsValues(contactColumns, CONTACT_SYSTEM_FIELDS)
        }).then(result => {
          if (result.isConfirmed) {
            Swal.fire({ title: 'Adding Contact...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
            google.script.run
              .withSuccessHandler(data => {
                Swal.close();
                renderTable(data);
                Swal.fire({ title: 'Contact added', icon: 'success', timer: 1500, showConfirmButton: false, heightAuto: false, scrollbarPadding: false });
              })
              .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
              .addContactToAccount(accountId, result.value);
          }
        });
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getSheetData('Contacts');
  };

  // Jumps to the Contacts tab pre-filtered to this account's name - previously the
  // only way to check who's already linked was switching tabs and scanning by eye.
  window.viewContactsForAccount = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const nameIdx = columns.findIndex(c => c.name === 'Account Name');
    const accountName = nameIdx > -1 ? rowData[nameIdx] : '';

    if (!accountName) { Swal.fire('Error', "Could not determine this account's name.", 'error'); return; }

    pendingTableFilter = { view: 'Contacts', col: 'Account', val: accountName };
    switchTab('Contacts');
  };

  // --- VISITS (Accounts) ---
  let currentVisitsContext = null;
  let visitsChanged = false;

  function todayInputValue() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function getAccountFromRow(rowIndex) {
    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === 'Account ID');
    const nameIdx = columns.findIndex(c => c.name === 'Account Name');
    return {
      accountId: idIdx > -1 ? rowData[idIdx] : null,
      accountName: nameIdx > -1 ? rowData[nameIdx] : 'this account'
    };
  }

  window.promptLogVisit = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const acc = getAccountFromRow(rowIndex);
    if (!acc.accountId) { Swal.fire('Error', 'Could not determine the Account ID for this row.', 'error'); return; }

    Swal.fire({
      title: `Log Visit - ${acc.accountName}`,
      html: `
        <div class="form-field">
          <label class="form-label">Visit Date</label>
          <input id="visit-date" type="date" class="swal2-input swal-field-input" value="${todayInputValue()}">
        </div>
        <div class="form-field">
          <label class="form-label">Notes</label>
          <textarea id="visit-notes" class="swal2-textarea" style="margin:0; width:100%; box-sizing:border-box;" placeholder="What happened on this visit?"></textarea>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Log Visit',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
        const date = document.getElementById('visit-date').value;
        if (!date) { Swal.showValidationMessage('A visit date is required'); return false; }
        return { date: date, notes: document.getElementById('visit-notes').value };
      }
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Logging visit...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => {
            Swal.close();
            renderTable(data);
            Swal.fire({ title: 'Visit logged', icon: 'success', timer: 1400, showConfirmButton: false, heightAuto: false, scrollbarPadding: false });
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .logVisit(acc.accountId, result.value.date, result.value.notes);
      }
    });
  };

  window.openVisitsModal = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const acc = getAccountFromRow(rowIndex);
    if (!acc.accountId) { Swal.fire('Error', 'Could not determine the Account ID for this row.', 'error'); return; }
    currentVisitsContext = acc;
    visitsChanged = false;

    Swal.fire({ title: 'Loading visits...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(visits => {
        Swal.close();
        showVisitsModal(visits);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listVisits(acc.accountId);
  };

  function renderVisitsListHtml(visits) {
    if (!visits || visits.length === 0) {
      return '<p class="manage-columns-empty">No visits logged yet.</p>';
    }
    return visits.map(v => `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid #e1e5eb; text-align:left;">
        <div style="min-width:0;">
          <div style="font-size:13px; font-weight:700; color:#11141a;">${escapeHtml(v.visitDate)}</div>
          <div style="font-size:12px; color:#5c6673; white-space:pre-wrap; word-break:break-word;">${escapeHtml(v.notes) || '<span style="color:#a0aabf;">No notes</span>'}</div>
        </div>
        <button class="btn btn-secondary btn-danger-outline" style="padding:4px 10px; font-size:12px; flex-shrink:0;" onclick="promptDeleteVisit('${escapeHtml(v.visitId)}')">Delete</button>
      </div>`).join('');
  }

  function showVisitsModal(visits) {
    Swal.fire({
      title: `Visits - ${currentVisitsContext.accountName}`,
      html: `<div style="max-height:320px; overflow-y:auto;">${renderVisitsListHtml(visits)}</div>`,
      showCloseButton: true,
      showConfirmButton: false,
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      // Only reload when the USER actually closed the modal (X / Esc / backdrop) after a
      // change - not when it was replaced by the delete-confirm popup (dismiss is
      // undefined in that case), which would otherwise clobber the confirm dialog.
      const userClosed = result.dismiss === Swal.DismissReason.close
        || result.dismiss === Swal.DismissReason.esc
        || result.dismiss === Swal.DismissReason.backdrop;
      if (userClosed && visitsChanged && window.currentView === 'Accounts') {
        visitsChanged = false;
        loadData('Accounts');
      }
    });
  }

  window.promptDeleteVisit = function(visitId) {
    Swal.fire({
      title: 'Delete this visit?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(visits => { visitsChanged = true; Swal.close(); showVisitsModal(visits); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteVisit(visitId);
      }
    });
  };

  window.promptDeleteRecord = function(e, rowIndex) {
    e.preventDefault();
    Swal.fire({
      title: 'Delete Record?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => {
            Swal.close();
            renderTable(data);
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteRecordRow(window.currentView, rowIndex);
      }
    });
  };

  window.handleExistingDataChange = function(rowIndex, colName, newValue) {
    google.script.run
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .updateCellData(window.currentView, rowIndex, colName, newValue);
  };

  // --- COLUMN MANAGEMENT W/ DROPDOWN SUPPORT ---
  let pendingColumns = [];
  // ID columns are kept out of the Manage Columns UI (never shown) but preserved on
  // save so they aren't dropped from the sheet.
  let preservedIdColumns = [];
  let draggedIdx = null;

  document.getElementById('manageColumnsBtn').addEventListener('click', () => {
    Swal.fire({
      title: 'Loading...',
      allowOutsideClick: false,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => Swal.showLoading()
    });
    google.script.run
      .withSuccessHandler(data => {
        const toState = c => ({ oldName: c.name, newName: c.name, type: c.type, options: c.options || [] });
        pendingColumns = data.columns.filter(c => !isIdColumn(c.name)).map(toState);
        preservedIdColumns = data.columns.filter(c => isIdColumn(c.name)).map(toState);
        showManageColumnsModal();
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getSheetData(window.currentView);
  });

  function showManageColumnsModal() {
    // Every field stacks on its own row (full width) instead of sharing a row with
    // a button - a fixed-width Swal popup plus a flex row of input+select+button
    // has no reliable amount of slack, and previously overflowed/clipped the button
    // the moment a font or padding change nudged the math the wrong way. Stacking
    // is immune to that regardless of exact pixel metrics, and reads cleaner besides.
    const html = `
      <div id="manage-cols-container" style="text-align:left;">
        <div class="add-column-panel">
          <div class="form-field">
            <label class="form-label">New Column Name</label>
            <input id="swal-new-col-name" class="swal2-input swal-field-input" placeholder="e.g. Annual Revenue">
          </div>
          <div class="form-field">
            <label class="form-label">Field Type</label>
            <select id="swal-new-col-type" class="swal2-select swal-field-select" onchange="toggleNewColOptions(this.value)">
              <option value="text">Text</option>
              <option value="dropdown">Dropdown</option>
              <option value="date">Date</option>
            </select>
          </div>
          <div class="form-field" id="swal-new-col-opts-wrap" style="display:none;">
            <label class="form-label">Dropdown Options</label>
            <input id="swal-new-col-opts" class="swal2-input swal-field-input" placeholder="Comma-separated, e.g. New, Hot, Cold">
          </div>
          <button class="btn add-column-btn" onclick="triggerAddColumn()">+ Add Column</button>
        </div>
        <p class="manage-columns-hint">Drag the handles (⋮⋮) below to reorder existing columns.</p>
        <div id="col-list-container"></div>
      </div>`;

    Swal.fire({
      title: 'Manage Columns',
      html: html,
      showCancelButton: true,
      confirmButtonText: 'Save Changes',
      cancelButtonText: 'Cancel',
      width: '540px',
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => { updateModalDOM(); },
      preConfirm: () => { return pendingColumns; }
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({
          title: 'Applying Changes...',
          allowOutsideClick: false,
          heightAuto: false,
          scrollbarPadding: false,
          didOpen: () => Swal.showLoading()
        });
        google.script.run
          .withSuccessHandler(data => {
            Swal.close();
            if (window.currentView === 'Deals') renderDealsBoard(data); else renderTable(data);
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          // Re-append the hidden ID columns so they survive the sync (never dropped).
          .syncColumns(window.currentView, result.value.concat(preservedIdColumns));
      }
    });
  }

  window.toggleNewColOptions = function(val) {
    document.getElementById('swal-new-col-opts-wrap').style.display = val === 'dropdown' ? 'block' : 'none';
  };

  function updateModalDOM() {
    const container = document.getElementById('col-list-container');
    if (!container) return;

    let html = '';
    if (pendingColumns.length === 0) {
      html = '<p class="manage-columns-empty">No columns exist yet.</p>';
    } else {
      pendingColumns.forEach((col, index) => {
        html += `
          <div class="draggable-item" draggable="true"
               ondragstart="handleDragStart(event, ${index})"
               ondragover="handleDragOver(event)"
               ondrop="handleDrop(event, ${index})">
            <div>
              <span class="drag-handle">⋮⋮</span>
              <span class="draggable-item-name">${escapeHtml(col.newName)} <span class="draggable-item-type">(${escapeHtml(col.type)})</span></span>
            </div>
            <div>
              <button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; margin-right:6px;" onclick="triggerEditColumn(${index})">Edit</button>
              <button class="btn btn-secondary btn-danger-outline" style="padding:6px 12px; font-size:12px;" onclick="triggerDeleteColumn(${index})">Delete</button>
            </div>
          </div>`;
      });
    }
    container.innerHTML = html;

    const inputName = document.getElementById('swal-new-col-name');
    const inputOpts = document.getElementById('swal-new-col-opts');
    const inputOptsWrap = document.getElementById('swal-new-col-opts-wrap');
    const typeSelect = document.getElementById('swal-new-col-type');
    if (inputName) inputName.value = '';
    if (inputOpts) inputOpts.value = '';
    if (inputOptsWrap) inputOptsWrap.style.display = 'none';
    if (typeSelect) typeSelect.value = 'text';
  }

  window.triggerAddColumn = function() {
    const name = document.getElementById('swal-new-col-name').value.trim();
    const type = document.getElementById('swal-new-col-type').value;
    const optsRaw = document.getElementById('swal-new-col-opts').value;

    if (name) {
      let options = [];
      if (type === 'dropdown' && optsRaw.trim() !== '') {
        options = optsRaw.split(',').map(s => s.trim()).filter(s => s);
      }
      pendingColumns.push({ oldName: null, newName: name, type: type, options: options });
      updateModalDOM();
    }
  };

  window.triggerEditColumn = function(index) {
    const col = pendingColumns[index];
    const optsStr = col.options ? col.options.join(', ') : '';

    Swal.fire({
      title: 'Edit Column',
      html: `
        <div class="form-field">
          <label class="form-label">Column Name</label>
          <input id="edit-col-name" class="swal2-input swal-field-input" value="${escapeHtml(col.newName)}" placeholder="Column name">
        </div>
        <div class="form-field">
          <label class="form-label">Field Type</label>
          <select id="edit-col-type" class="swal2-select swal-field-select" onchange="document.getElementById('edit-col-opts-wrap').style.display = this.value === 'dropdown' ? 'block' : 'none'">
            <option value="text" ${col.type === 'text' ? 'selected' : ''}>Text</option>
            <option value="dropdown" ${col.type === 'dropdown' ? 'selected' : ''}>Dropdown</option>
            <option value="date" ${col.type === 'date' ? 'selected' : ''}>Date</option>
          </select>
        </div>
        <div class="form-field" id="edit-col-opts-wrap" style="display: ${col.type === 'dropdown' ? 'block' : 'none'};">
          <label class="form-label">Dropdown Options</label>
          <input id="edit-col-opts" class="swal2-input swal-field-input" value="${escapeHtml(optsStr)}" placeholder="Comma-separated, e.g. New, Hot, Cold">
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Save',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
         const n = document.getElementById('edit-col-name').value.trim();
         const t = document.getElementById('edit-col-type').value;
         const oRaw = document.getElementById('edit-col-opts').value;
         if (!n) { Swal.showValidationMessage('Column name is required'); return false; }
         let o = [];
         if (t === 'dropdown' && oRaw.trim() !== '') {
           o = oRaw.split(',').map(s => s.trim()).filter(s => s);
         }
         return { newName: n, type: t, options: o };
      }
    }).then(result => {
      if (result.isConfirmed) {
        pendingColumns[index].newName = result.value.newName;
        pendingColumns[index].type = result.value.type;
        pendingColumns[index].options = result.value.options;
      }
      showManageColumnsModal();
    });
  };

  window.triggerDeleteColumn = function(index) {
    pendingColumns.splice(index, 1);
    updateModalDOM();
  };

  window.handleDragStart = function(e, index) {
    draggedIdx = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index);
    }
  };
  
  window.handleDragOver = function(e) { e.preventDefault(); };
  
  window.handleDrop = function(e, targetIdx) {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx) return;
    const item = pendingColumns.splice(draggedIdx, 1)[0];
    pendingColumns.splice(targetIdx, 0, item);
    draggedIdx = null;
    updateModalDOM();
  };

  // --- IMPORT SPREADSHEET ---
  function runImport(view, rectangularData, mode, keyColumn) {
    Swal.fire({ title: 'Saving to Database...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(responseData => {
        Swal.close();
        if (view === 'Deals') renderDealsBoard(responseData); else renderTable(responseData);
        const s = responseData.importSummary;
        Swal.fire({
          title: 'Imported',
          text: s ? `${s.updated} updated, ${s.added} added.` : 'Data successfully imported.',
          icon: 'success',
          timer: s ? 2600 : 2000,
          showConfirmButton: false,
          heightAuto: false,
          scrollbarPadding: false
        });
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .importSpreadsheetData(view, rectangularData, mode || null, keyColumn || null);
  }

  // After parsing the file, ask how to apply it: merge (upsert on a key column) or wipe.
  function chooseImportModeAndRun(view, rectangularData) {
    const headers = (rectangularData[0] || []).map(h => String(h).trim());
    const sheetCols = (window.currentTableData.columns || []).map(c => c.name);
    // Columns present in BOTH the file and the sheet make valid match keys (skip IDs).
    const keyable = headers.filter(h => h !== '' && !isIdColumn(h) &&
      sheetCols.some(sc => sc.toLowerCase() === h.toLowerCase()));

    if (keyable.length === 0) {
      // Nothing to match on - only a full replace is meaningful here.
      Swal.fire({
        title: 'Replace all data?',
        text: "No column in the file matches this tab, so rows can't be matched. Importing will replace ALL existing data.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Replace all',
        confirmButtonColor: '#d93025',
        heightAuto: false,
        scrollbarPadding: false
      }).then(r => { if (r.isConfirmed) runImport(view, rectangularData, 'replace'); });
      return;
    }

    const keyOpts = keyable.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    Swal.fire({
      title: 'Import Options',
      html: `
        <div class="form-field">
          <label class="form-label">How should this file be applied?</label>
          <select id="import-mode" class="swal2-select swal-field-select" style="width:100%;" onchange="document.getElementById('import-key-wrap').style.display = this.value === 'upsert' ? 'block' : 'none';">
            <option value="upsert">Update existing &amp; add new</option>
            <option value="replace">Replace all (wipe first)</option>
          </select>
        </div>
        <div class="form-field" id="import-key-wrap">
          <label class="form-label">Match existing rows by</label>
          <select id="import-key" class="swal2-select swal-field-select" style="width:100%;">${keyOpts}</select>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Import',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
        const mode = document.getElementById('import-mode').value;
        const key = document.getElementById('import-key').value;
        return { mode: mode, key: mode === 'upsert' ? key : null };
      }
    }).then(r => {
      if (r.isConfirmed) runImport(view, rectangularData, r.value.mode, r.value.key);
    });
  }

  document.getElementById('importBtn').addEventListener('click', async () => {
    const view = window.currentView;
    const { value: file } = await Swal.fire({
      title: 'Upload Spreadsheet',
      text: 'Choose a .csv or Excel file. You can update existing records or replace everything.',
      input: 'file',
      inputAttributes: {
        'accept': '.csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel',
        'aria-label': 'Upload your Excel or CSV file'
      },
      showCancelButton: true,
      confirmButtonText: 'Next',
      heightAuto: false,
      scrollbarPadding: false
    });

    if (file) {
      Swal.fire({ title: 'Reading file...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });

      const reader = new FileReader();
      reader.onload = function(e) {
        const workbook = XLSX.read(e.target.result, { type: 'binary' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (json.length === 0) {
          Swal.fire({ title: 'Error', text: 'The uploaded file is empty.', icon: 'error', heightAuto: false, scrollbarPadding: false });
          return;
        }

        let maxCols = 0;
        json.forEach(row => { if (row.length > maxCols) maxCols = row.length; });
        const rectangularData = json.map(row => {
          const newRow = [...row];
          while (newRow.length < maxCols) newRow.push('');
          return newRow;
        });

        Swal.close();
        chooseImportModeAndRun(view, rectangularData);
      };
      reader.readAsBinaryString(file);
    }
  });

  // --- DEALS KANBAN ---
  const DEAL_STAGES = ['Awaiting Decision', 'Proposed Bid', 'Closed Won', 'Closed Lost'];
  const DEAL_SYSTEM_FIELDS = ['Deal ID', 'Stage', 'Created Time', 'Closed Date', 'Lost Reason'];
  const STAGE_TO_SLUG = {
    'Awaiting Decision': 'awaiting-decision',
    'Proposed Bid': 'proposed-bid',
    'Closed Won': 'closed-won',
    'Closed Lost': 'closed-lost',
    'Other': 'other'
  };
  let draggedDealId = null;

  function loadDealsBoard() {
    Swal.fire({
      title: 'Loading Deals...',
      allowOutsideClick: false,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => { Swal.showLoading(); }
    });
    google.script.run
      .withSuccessHandler(data => {
        Swal.close();
        renderDealsBoard(data);
      })
      .withFailureHandler(err => {
        Swal.fire('Error', err.message, 'error');
      })
      .getDealsBoard();
  }

  // Amount comes through as a display string (getDealsBoard uses getDisplayValues so
  // dropdown/date columns render however the sheet formats them) - if the Amount
  // column has been given Currency/number formatting in Sheets directly, that string
  // can look like "$1,234.00" rather than "1234". Strip everything but digits/./-  so
  // that display formatting doesn't get misread as the value itself.
  function parseAmountValue(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number') return value;
    const cleaned = value.toString().replace(/[^0-9.\-]/g, '');
    return cleaned === '' ? NaN : parseFloat(cleaned);
  }

  function formatDealAmount(value) {
    const num = parseAmountValue(value);
    if (isNaN(num)) return '—';
    return '₱' + num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function getDealCurrentStage(dealId) {
    const columns = window.currentTableData.columns;
    const dealIdIdx = columns.findIndex(c => c.name === 'Deal ID');
    const stageIdx = columns.findIndex(c => c.name === 'Stage');
    const row = window.currentTableData.rows.find(r => r[dealIdIdx] === dealId);
    return row ? row[stageIdx] : null;
  }

  function populateKanbanFilters(data) {
    const repIdx = data.columns.findIndex(c => c.name === 'Sales Rep');
    const terrIdx = data.columns.findIndex(c => c.name === 'Territory');
    const build = (selectId, colIdx, allLabel) => {
      const sel = document.getElementById(selectId);
      const current = sel.value;
      const seen = {};
      const vals = [];
      if (colIdx > -1) {
        // Collapse casing variants to one option (keep first-seen spelling).
        data.rows.forEach(r => { const v = (r[colIdx] === null || r[colIdx] === undefined) ? '' : String(r[colIdx]).trim(); const k = v.toLowerCase(); if (v !== '' && !seen[k]) { seen[k] = true; vals.push(v); } });
      }
      vals.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      let html = `<option value="">${allLabel}</option>`;
      vals.forEach(v => { html += `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`; });
      html += `<option value="(Unassigned)">(Unassigned)</option>`;
      sel.innerHTML = html;
      sel.value = current;
    };
    build('kanbanRep', repIdx, 'All reps');
    build('kanbanTerritory', terrIdx, 'All territories');
  }

  function dealMatchesKanbanFilter(row, columns) {
    const repFilter = document.getElementById('kanbanRep').value;
    const terrFilter = document.getElementById('kanbanTerritory').value;
    const check = (filter, colName) => {
      if (!filter) return true;
      const idx = columns.findIndex(c => c.name === colName);
      const v = (idx > -1 && row[idx] !== null && row[idx] !== undefined) ? String(row[idx]).trim() : '';
      // Case-insensitive so "BATANGAS" matches a "Batangas" selection.
      return filter === '(Unassigned)' ? v === '' : v.toLowerCase() === filter.toLowerCase();
    };
    return check(repFilter, 'Sales Rep') && check(terrFilter, 'Territory');
  }

  function renderDealsBoard(data) {
    window.currentTableData = data;
    populateKanbanFilters(data);

    const dealIdIdx = data.columns.findIndex(c => c.name === 'Deal ID');
    const stageIdx = data.columns.findIndex(c => c.name === 'Stage');

    const buckets = { 'Awaiting Decision': [], 'Proposed Bid': [], 'Closed Won': [], 'Closed Lost': [], 'Other': [] };

    data.rows.forEach(row => {
      if (!dealMatchesKanbanFilter(row, data.columns)) return;
      const stageRaw = ((stageIdx > -1 ? row[stageIdx] : '') || '').toString().trim().toLowerCase();
      const match = DEAL_STAGES.find(s => s.toLowerCase() === stageRaw);
      buckets[match || 'Other'].push(row);
    });

    Object.keys(STAGE_TO_SLUG).forEach(stage => {
      const slug = STAGE_TO_SLUG[stage];
      const body = document.getElementById('kanban-body-' + slug);
      const countEl = document.getElementById('kanban-count-' + slug);
      const rows = buckets[stage];
      countEl.innerText = rows.length;

      if (rows.length === 0) {
        body.innerHTML = '<div class="kanban-empty-placeholder">No deals here</div>';
      } else {
        body.innerHTML = rows.map(row => renderDealCard(row, data.columns, dealIdIdx)).join('');
      }
    });

    document.getElementById('kanban-column-other').style.display = buckets['Other'].length > 0 ? 'flex' : 'none';
  }

  ['kanbanRep', 'kanbanTerritory'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => renderDealsBoard(window.currentTableData));
  });

  function renderDealCard(row, columns, dealIdIdx) {
    const dealId = row[dealIdIdx];
    const safeDealId = escapeHtml(dealId);
    const get = name => {
      const idx = columns.findIndex(c => c.name === name);
      return idx > -1 ? row[idx] : '';
    };

    const dealName = get('Deal Name') || 'Untitled Deal';
    const accountDisplay = (get('Account') || '').toString().replace(/\s*\[[^\]]*\]\s*$/, '');
    const amount = formatDealAmount(get('Amount'));
    const created = get('Created Time');

    return `
      <div class="kanban-card" draggable="true" data-deal-id="${safeDealId}"
           ondragstart="handleDealDragStart(event, '${safeDealId}')" ondragend="handleDealDragEnd(event)">
        <div class="kanban-card-header">
          <span class="kanban-card-title" title="${escapeHtml(dealName)}">${escapeHtml(dealName)}</span>
          <div class="action-dropdown">
            <button class="action-btn" onclick="toggleActionMenu(event, 'deal-${safeDealId}')">⋮</button>
            <div id="action-menu-deal-${safeDealId}" class="action-menu-content">
              <a href="#" onclick="promptMoveDealToStage(event, '${safeDealId}')">Move to Stage</a>
              <a href="#" onclick="promptEditDeal(event, '${safeDealId}')">Edit Deal</a>
              <a href="#" onclick="openDealLineItemsModal(event, '${safeDealId}', '${escapeHtml(dealName).replace(/'/g, "\\'")}')">Products</a>
              <a href="#" onclick="downloadDealQuote(event, '${safeDealId}')">Generate Quote</a>
              <a href="#" onclick="openTasksModal(event, 'Deal', '${safeDealId}', '${escapeHtml(dealName).replace(/'/g, "\\'")}')">Tasks</a>
              <a href="#" onclick="openAttachmentsModalForDeal(event, '${safeDealId}')">Attachments</a>
              <a href="#" onclick="promptDeleteDeal(event, '${safeDealId}')" style="color: #d93025; border-top: 1px solid #e1e5eb;">Delete</a>
            </div>
          </div>
        </div>
        <div class="kanban-card-account" title="${escapeHtml(accountDisplay)}">${escapeHtml(accountDisplay) || 'No account linked'}</div>
        <div class="kanban-card-footer">
          <span class="kanban-card-amount">${amount}</span>
          <span class="kanban-card-age">${created ? 'Created ' + escapeHtml(created) : ''}</span>
        </div>
        <button class="kanban-card-move-btn" onclick="promptMoveDealToStage(event, '${safeDealId}')">Move ›</button>
      </div>`;
  }

  // --- KANBAN DRAG AND DROP (separate from the Manage Columns drag handlers above) ---
  window.handleDealDragStart = function(e, dealId) {
    draggedDealId = dealId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dealId);
    e.target.classList.add('dragging');
  };

  window.handleDealDragEnd = function(e) {
    e.target.classList.remove('dragging');
  };

  window.handleDealDragOver = function(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  };

  window.handleDealDragLeave = function(e) {
    e.currentTarget.classList.remove('drag-over');
  };

  window.handleDealDrop = function(e, targetStage) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const dealId = draggedDealId;
    draggedDealId = null;
    if (!dealId) return;

    if (targetStage === 'Other') {
      Swal.fire({ title: 'Not a valid stage', text: "Deals can't be dropped here - this column only holds deals with an unrecognized stage value. Use Move to Stage instead.", icon: 'info', heightAuto: false, scrollbarPadding: false });
      return;
    }

    const currentStage = getDealCurrentStage(dealId);
    if (currentStage === targetStage) return;

    dispatchStageChange(dealId, currentStage, targetStage);
  };

  function dispatchStageChange(dealId, currentStage, targetStage) {
    if (targetStage === 'Proposed Bid') {
      promptBidAmount(dealId);
    } else if (targetStage === 'Closed Won') {
      promptCloseWon(dealId);
    } else if (targetStage === 'Closed Lost') {
      promptCloseLost(dealId);
    } else {
      promptGenericStageChange(dealId, targetStage);
    }
  }

  function commitDealStageChange(dealId, newStage, extra) {
    Swal.fire({ title: 'Updating stage...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(data => {
        Swal.close();
        renderDealsBoard(data);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .updateDealStage(dealId, newStage, extra || {});
  }

  function promptBidAmount(dealId) {
    const columns = window.currentTableData.columns;
    const dealIdIdx = columns.findIndex(c => c.name === 'Deal ID');
    const amountIdx = columns.findIndex(c => c.name === 'Amount');
    const row = window.currentTableData.rows.find(r => r[dealIdIdx] === dealId);
    const existingAmount = row ? parseAmountValue(row[amountIdx]) : NaN;

    Swal.fire({
      title: 'Proposed Bid Amount',
      input: 'number',
      inputLabel: 'Enter the bid amount for this deal (₱)',
      inputValue: isNaN(existingAmount) ? '' : existingAmount,
      inputAttributes: { min: 0, step: '0.01' },
      showCancelButton: true,
      confirmButtonText: 'Move to Proposed Bid',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      inputValidator: (value) => {
        if (value === '' || value === null || isNaN(value) || parseFloat(value) <= 0) {
          return 'Enter a valid bid amount greater than 0';
        }
      }
    }).then(result => {
      if (result.isConfirmed) {
        commitDealStageChange(dealId, 'Proposed Bid', { amount: parseFloat(result.value) });
      }
    });
  }

  function promptCloseWon(dealId) {
    Swal.fire({
      title: 'Mark Deal as Won?',
      icon: 'success',
      showCancelButton: true,
      confirmButtonText: 'Closed Won',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        commitDealStageChange(dealId, 'Closed Won', {});
      }
    });
  }

  function promptCloseLost(dealId) {
    Swal.fire({
      title: 'Mark Deal as Lost?',
      html: `<input id="swal-lost-reason" class="swal2-input" style="margin:0;" placeholder="Reason (optional)">`,
      showCancelButton: true,
      confirmButtonText: 'Closed Lost',
      confirmButtonColor: '#d93025',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
        const el = document.getElementById('swal-lost-reason');
        return el ? el.value : '';
      }
    }).then(result => {
      if (result.isConfirmed) {
        commitDealStageChange(dealId, 'Closed Lost', { lostReason: result.value || '' });
      }
    });
  }

  function promptGenericStageChange(dealId, targetStage) {
    Swal.fire({
      title: `Move to ${targetStage}?`,
      showCancelButton: true,
      confirmButtonText: 'Move',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        commitDealStageChange(dealId, targetStage, {});
      }
    });
  }

  window.promptMoveDealToStage = function(e, dealId) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    const currentStage = getDealCurrentStage(dealId);
    const options = DEAL_STAGES.filter(s => s !== currentStage);
    const inputOptions = {};
    options.forEach(s => { inputOptions[s] = s; });

    Swal.fire({
      title: 'Move to Stage',
      input: 'select',
      inputOptions: inputOptions,
      inputPlaceholder: 'Select a stage',
      showCancelButton: true,
      confirmButtonText: 'Continue',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed && result.value) {
        dispatchStageChange(dealId, currentStage, result.value);
      }
    });
  };

  window.promptDeleteDeal = function(e, dealId) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    Swal.fire({
      title: 'Delete Deal?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDealsBoard(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteDealById(dealId);
      }
    });
  };

  // --- SHARED DYNAMIC FIELD FORM BUILDER (Edit Deal / New Deal / Add Contact) ---
  function buildDynamicFieldsHtml(columns, excludeNames, valuesByName) {
    valuesByName = valuesByName || {};
    return columns
      .filter(col => excludeNames.indexOf(col.name) === -1)
      .map(col => {
        const fieldId = 'dyn-field-' + col.name.replace(/[^a-zA-Z0-9]/g, '_');
        const currentValue = valuesByName[col.name] || '';
        if (col.name === 'Amount' || col.name === 'Unit Price') {
          // Same number/peso treatment promptBidAmount already gives Amount at the
          // Proposed Bid stage - giving it here too means "50k" can't get typed in at
          // deal creation and silently misparsed later by parseAmountValue's regex.
          return `<div style="text-align:left; margin-bottom:10px;">
            <label style="font-size:12px; color:#5c6673; display:block; margin-bottom:4px;">${escapeHtml(col.name)} (₱)</label>
            <input id="${fieldId}" type="number" min="0" step="0.01" class="swal2-input" style="margin:0; width:100%; box-sizing:border-box;" value="${escapeHtml(currentValue)}">
          </div>`;
        }
        if (col.type === 'dropdown') {
          const optionsHtml = col.options.map(opt =>
            `<option value="${escapeHtml(opt)}" ${opt === currentValue ? 'selected' : ''}>${escapeHtml(opt)}</option>`
          ).join('');
          return `<div style="text-align:left; margin-bottom:10px;">
            <label style="font-size:12px; color:#5c6673; display:block; margin-bottom:4px;">${escapeHtml(col.name)}</label>
            <select id="${fieldId}" class="swal2-select" style="margin:0; width:100%;">
              <option value=""></option>${optionsHtml}
            </select>
          </div>`;
        }
        if (col.type === 'date') {
          // A native date picker guarantees YYYY-MM-DD on its own, rather than relying
          // on the free-text loose-date-parsing that plain "date-shaped-by-name" fields
          // get (see normalizeDateInput) - a value that doesn't already match that exact
          // format (e.g. leftover free text from before the column became type:'date')
          // just shows blank until a new date is picked, same as any date input.
          return `<div style="text-align:left; margin-bottom:10px;">
            <label style="font-size:12px; color:#5c6673; display:block; margin-bottom:4px;">${escapeHtml(col.name)}</label>
            <input id="${fieldId}" type="date" class="swal2-input" style="margin:0; width:100%; box-sizing:border-box;" value="${escapeHtml(currentValue)}">
          </div>`;
        }
        return `<div style="text-align:left; margin-bottom:10px;">
          <label style="font-size:12px; color:#5c6673; display:block; margin-bottom:4px;">${escapeHtml(col.name)}</label>
          <input id="${fieldId}" class="swal2-input" style="margin:0; width:100%; box-sizing:border-box;" value="${escapeHtml(currentValue)}">
        </div>`;
      }).join('');
  }

  function readDynamicFieldsValues(columns, excludeNames) {
    const result = {};
    columns
      .filter(col => excludeNames.indexOf(col.name) === -1)
      .forEach(col => {
        const fieldId = 'dyn-field-' + col.name.replace(/[^a-zA-Z0-9]/g, '_');
        const el = document.getElementById(fieldId);
        if (el) result[col.name] = normalizeDateInput(col.name, el.value);
      });
    return result;
  }

  window.promptEditDeal = function(e, dealId) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const columns = window.currentTableData.columns;
    const dealIdIdx = columns.findIndex(c => c.name === 'Deal ID');
    const row = window.currentTableData.rows.find(r => r[dealIdIdx] === dealId);
    if (!row) { Swal.fire('Error', 'Deal not found.', 'error'); return; }

    const valuesByName = {};
    columns.forEach((col, idx) => { valuesByName[col.name] = row[idx]; });

    Swal.fire({
      title: 'Edit Deal',
      html: buildDynamicFieldsHtml(columns, DEAL_SYSTEM_FIELDS, valuesByName),
      showCancelButton: true,
      confirmButtonText: 'Save',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => readDynamicFieldsValues(columns, DEAL_SYSTEM_FIELDS)
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Saving...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDealsBoard(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .updateDealFields(dealId, result.value);
      }
    });
  };

  document.getElementById('newDealBtn').addEventListener('click', () => {
    const columns = window.currentTableData.columns;
    Swal.fire({
      title: 'New Deal',
      html: buildDynamicFieldsHtml(columns, DEAL_SYSTEM_FIELDS, {}),
      showCancelButton: true,
      confirmButtonText: 'Create Deal',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => readDynamicFieldsValues(columns, DEAL_SYSTEM_FIELDS)
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Creating Deal...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDealsBoard(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .addNewDeal(result.value);
      }
    });
  });

  // "+ New" button beside Import Data - a modal form alternative to typing straight
  // into the sticky add-row at the bottom of the table (which is easy to miss on a
  // long table, and requires scrolling all the way down first).
  const NEW_RECORD_LABEL = { Leads: 'Lead', Contacts: 'Contact', Accounts: 'Account', Products: 'Product' };
  const NEW_RECORD_SYSTEM_FIELDS = {
    Leads: ['Lead ID'],
    Contacts: ['Contact ID'],
    // Last Visit/Visit Count are maintained by the Log Visit feature, not entered by hand.
    Accounts: ['Account ID', 'Last Visit', 'Visit Count', 'Created Time'],
    Products: ['Product ID'],
  };

  document.getElementById('newRecordBtn').addEventListener('click', () => {
    const view = window.currentView;
    const columns = window.currentTableData.columns;
    const excludeFields = NEW_RECORD_SYSTEM_FIELDS[view] || [];
    const label = NEW_RECORD_LABEL[view] || view;

    Swal.fire({
      title: `New ${label}`,
      html: buildDynamicFieldsHtml(columns, excludeFields, {}),
      showCancelButton: true,
      confirmButtonText: `Create ${label}`,
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
        const values = readDynamicFieldsValues(columns, excludeFields);
        // A Contact saved without an Account link is orphaned, with nothing
        // connecting it back to who it's actually for.
        if (view === 'Contacts') {
          const accountCol = ['Account Name', 'Account'].find(name => name in values);
          if (accountCol && !values[accountCol].trim()) {
            Swal.showValidationMessage('Pick an Account before adding this Contact.');
            return false;
          }
        }
        return values;
      }
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: `Creating ${label}...`, allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => {
            Swal.close();
            renderTable(data);
            Swal.fire({ title: `${label} added`, icon: 'success', timer: 1500, showConfirmButton: false, heightAuto: false, scrollbarPadding: false });
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .addRecordData(view, result.value);
      }
    });
  });

  // Plain navigation (not fetch) - the browser handles the file download and
  // Content-Disposition itself, no JS-side blob/save-dialog plumbing needed.
  document.getElementById('exportBtn').addEventListener('click', () => {
    window.location.href = '/export/' + encodeURIComponent(window.currentView);
  });

  window.downloadDealQuote = function(e, dealId) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    window.location.href = '/quote/' + encodeURIComponent(dealId);
  };

  // --- LEAD ATTACHMENTS ---
  const MAX_ATTACHMENT_MB = 10;
  let currentAttachmentsContext = null;

  function formatFileSize(bytes) {
    const num = parseFloat(bytes);
    if (isNaN(num)) return '';
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    return (num / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Names every oversized file, not just the first - otherwise a batch of 5 with one
  // large file names only that one and leaves the rep unsure the other 4 were also
  // rejected (the whole batch is; nothing partial uploads).
  function oversizedFilesMessage(oversized) {
    const names = oversized.map(f => `"${f.name}"`).join(', ');
    const verb = oversized.length > 1 ? 'are' : 'is';
    return `${names} ${verb} over the ${MAX_ATTACHMENT_MB}MB limit.`;
  }

  window.openAttachmentsModal = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === 'Lead ID');
    const nameIdx = columns.findIndex(c => c.name === 'Name');
    const leadId = idIdx > -1 ? rowData[idIdx] : null;
    const leadLabel = nameIdx > -1 ? rowData[nameIdx] : 'this lead';

    if (!leadId) { Swal.fire('Error', 'Could not determine the Lead ID for this row.', 'error'); return; }
    openAttachmentsModalFor('Lead', leadId, leadLabel);
  };

  // --- DEAL LINE ITEMS (Products priced onto a Deal) ---
  let currentLineItemsContext = null; // { dealId, dealName }
  let lineItemsChanged = false;
  let lineItemsProductCache = null; // [{id, name, unitPrice}] - fetched once per modal open
  let currentLineItemsCache = []; // last-rendered items, so a validation error can redraw without re-fetching

  window.openDealLineItemsModal = function(e, dealId, dealName) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    currentLineItemsContext = { dealId, dealName };
    lineItemsChanged = false;

    Swal.fire({ title: 'Loading products...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(products => {
        lineItemsProductCache = (products.rows || []).map(r => {
          const idIdx = products.columns.findIndex(c => c.name === 'Product ID');
          const nameIdx = products.columns.findIndex(c => c.name === 'Product Name');
          const priceIdx = products.columns.findIndex(c => c.name === 'Unit Price');
          return { id: r[idIdx], name: r[nameIdx], unitPrice: parseFloat(r[priceIdx]) || 0 };
        });
        google.script.run
          .withSuccessHandler(items => { Swal.close(); showDealLineItemsModal(items); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .listDealLineItems(dealId);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getSheetData('Products');
  };

  function renderLineItemsListHtml(items) {
    if (!items || items.length === 0) {
      return '<p class="manage-columns-empty">No products added yet.</p>';
    }
    return items.map(it => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #e1e5eb; text-align:left;">
        <div style="min-width:0;">
          <div style="font-size:13px; font-weight:700; color:#11141a;">${escapeHtml(it.productName)}</div>
          <div style="font-size:12px; color:#5c6673;">${it.quantity} × ${formatDealAmount(it.unitPrice)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
          <span style="font-size:13px; font-weight:700;">${formatDealAmount(it.lineTotal)}</span>
          <button class="btn btn-secondary btn-danger-outline" style="padding:4px 10px; font-size:12px;" onclick="promptDeleteDealLineItem('${escapeHtml(it.lineItemId)}')">Delete</button>
        </div>
      </div>`).join('');
  }

  function showDealLineItemsModal(items) {
    currentLineItemsCache = items || [];
    const total = currentLineItemsCache.reduce((sum, it) => sum + (parseFloat(it.lineTotal) || 0), 0);
    const productOptions = lineItemsProductCache.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${formatDealAmount(p.unitPrice)})</option>`
    ).join('');

    Swal.fire({
      title: `Products - ${currentLineItemsContext.dealName}`,
      html: `
        <div style="max-height:280px; overflow-y:auto; margin-bottom:12px;">${renderLineItemsListHtml(items)}</div>
        <div style="text-align:right; font-size:14px; font-weight:700; margin-bottom:14px; padding-top:8px; border-top:2px solid #e1e5eb;">
          Total: ${formatDealAmount(total)}
        </div>
        ${lineItemsProductCache.length === 0
          ? '<p class="manage-columns-empty">No products in the catalog yet - add some from the Products tab first.</p>'
          : `<div style="display:flex; gap:8px; text-align:left;">
              <select id="line-item-product" class="swal2-select" style="margin:0; flex:2;">${productOptions}</select>
              <input id="line-item-qty" type="number" min="1" step="1" value="1" class="swal2-input" style="margin:0; flex:1;" placeholder="Qty">
              <button class="btn" style="flex-shrink:0;" onclick="submitAddDealLineItem()">Add</button>
            </div>`
        }
      `,
      showCloseButton: true,
      showConfirmButton: false,
      heightAuto: false,
      scrollbarPadding: false,
      width: 480
    }).then(result => {
      // Same reasoning as the Visits modal - only refresh the board (Amount may have
      // changed) when the user actually closed the modal after a real change, not
      // when it was replaced by the delete-confirm popup mid-edit.
      const userClosed = result.dismiss === Swal.DismissReason.close
        || result.dismiss === Swal.DismissReason.esc
        || result.dismiss === Swal.DismissReason.backdrop;
      if (userClosed && lineItemsChanged) {
        lineItemsChanged = false;
        loadDealsBoard();
      }
    });
  }

  window.submitAddDealLineItem = function() {
    const productId = document.getElementById('line-item-product').value;
    const qty = parseFloat(document.getElementById('line-item-qty').value);
    if (!productId || !qty || qty <= 0) {
      Swal.fire('Error', 'Pick a product and a quantity greater than 0.', 'error').then(() => showDealLineItemsModal(currentLineItemsCache));
      return;
    }
    google.script.run
      .withSuccessHandler(items => { lineItemsChanged = true; showDealLineItemsModal(items); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .addDealLineItem(currentLineItemsContext.dealId, productId, qty);
  };

  window.promptDeleteDealLineItem = function(lineItemId) {
    Swal.fire({
      title: 'Remove this product from the deal?',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Remove',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Removing...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(items => { lineItemsChanged = true; Swal.close(); showDealLineItemsModal(items); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteDealLineItem(lineItemId);
      }
    });
  };

  // --- TASKS (lightweight per-record to-dos, plus a global "My Tasks" list) ---
  let currentTasksContext = null; // { entityType, entityId, entityLabel }
  let tasksChanged = false;
  let currentTasksCache = []; // last-rendered items, so a validation error can redraw without re-fetching

  function openTasksModalCore(entityType, entityId, entityLabel) {
    currentTasksContext = { entityType, entityId, entityLabel };
    tasksChanged = false;
    Swal.fire({ title: 'Loading tasks...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(tasks => { Swal.close(); showTasksModal(tasks); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listTasksForEntity(entityType, entityId);
  }

  window.openTasksModalForRow = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    const config = PROFILE_ENTITY_CONFIG[window.currentView];
    if (!config) return;
    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === config.idCol);
    const entityId = idIdx > -1 ? rowData[idIdx] : null;
    if (!entityId) { Swal.fire('Error', 'Could not determine the record ID for this row.', 'error'); return; }
    openTasksModalCore(config.entityType, entityId, config.getTitle(rowData, columns));
  };

  window.openTasksModal = function(e, entityType, entityId, entityLabel) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    openTasksModalCore(entityType, entityId, entityLabel);
  };

  function renderTasksListHtml(tasks) {
    if (!tasks || tasks.length === 0) {
      return '<p class="manage-columns-empty">No tasks yet.</p>';
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    return tasks.map(t => {
      const isOverdue = !t.done && t.dueDate && t.dueDate < todayIso;
      return `
      <div style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #e1e5eb; text-align:left;">
        <input type="checkbox" ${t.done ? 'checked' : ''} onchange="submitToggleTaskDone('${escapeHtml(t.taskId)}')" style="flex-shrink:0; width:16px; height:16px; cursor:pointer;">
        <div style="min-width:0; flex:1;">
          <div style="font-size:13px; font-weight:700; color:${t.done ? '#a0aabf' : '#11141a'}; ${t.done ? 'text-decoration:line-through;' : ''}">${escapeHtml(t.title)}</div>
          ${t.dueDate ? `<div style="font-size:12px; color:${isOverdue ? '#d93025' : '#5c6673'};">Due ${escapeHtml(t.dueDate)}</div>` : ''}
        </div>
        <button class="btn btn-secondary btn-danger-outline" style="padding:4px 10px; font-size:12px; flex-shrink:0;" onclick="promptDeleteTask('${escapeHtml(t.taskId)}')">Delete</button>
      </div>`;
    }).join('');
  }

  function showTasksModal(tasks) {
    currentTasksCache = tasks || [];
    Swal.fire({
      title: `Tasks - ${currentTasksContext.entityLabel}`,
      html: `
        <div style="max-height:320px; overflow-y:auto; margin-bottom:12px;">${renderTasksListHtml(currentTasksCache)}</div>
        <div style="display:flex; gap:8px; text-align:left;">
          <input id="task-title" type="text" class="swal2-input" style="margin:0; flex:2;" placeholder="Task title">
          <input id="task-due" type="date" class="swal2-input" style="margin:0; flex:1;">
          <button class="btn" style="flex-shrink:0;" onclick="submitAddTask()">Add</button>
        </div>
      `,
      showCloseButton: true,
      showConfirmButton: false,
      heightAuto: false,
      scrollbarPadding: false,
      width: 480
    }).then(result => {
      // Same reasoning as the Deal Line Items modal - only refresh the underlying view
      // when the user actually closed the modal after a real change, not when it was
      // replaced by the delete-confirm popup mid-edit.
      const userClosed = result.dismiss === Swal.DismissReason.close
        || result.dismiss === Swal.DismissReason.esc
        || result.dismiss === Swal.DismissReason.backdrop;
      if (userClosed && tasksChanged) {
        tasksChanged = false;
        if (window.currentView === 'Deals') loadDealsBoard();
      }
    });
  }

  window.submitAddTask = function() {
    const title = document.getElementById('task-title').value;
    const due = document.getElementById('task-due').value;
    if (!(title || '').trim()) {
      Swal.fire('Error', 'A task title is required.', 'error').then(() => showTasksModal(currentTasksCache));
      return;
    }
    google.script.run
      .withSuccessHandler(tasks => { tasksChanged = true; showTasksModal(tasks); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .addTask(currentTasksContext.entityType, currentTasksContext.entityId, currentTasksContext.entityLabel, title, due);
  };

  window.submitToggleTaskDone = function(taskId) {
    google.script.run
      .withSuccessHandler(tasks => { tasksChanged = true; showTasksModal(tasks); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .toggleTaskDone(taskId);
  };

  window.promptDeleteTask = function(taskId) {
    Swal.fire({
      title: 'Delete this task?',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(tasks => { tasksChanged = true; Swal.close(); showTasksModal(tasks); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteTask(taskId);
      }
    });
  };

  // --- MY TASKS (a rep's own to-dos across every entity, one flat list) ---
  function loadMyTasks() {
    Swal.fire({
      title: 'Loading tasks...',
      allowOutsideClick: false,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => { Swal.showLoading(); }
    });
    google.script.run
      .withSuccessHandler(tasks => { Swal.close(); renderMyTasks(tasks); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listMyTasks();
  }

  function renderMyTasks(tasks) {
    document.getElementById('myTasksCount').textContent = tasks.filter(t => !t.done).length;
    const list = document.getElementById('myTasksList');
    if (!tasks || tasks.length === 0) {
      list.innerHTML = '<p class="home-empty">No tasks yet - add one from the Tasks action on any Lead, Contact, Account, or Deal.</p>';
      return;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    list.innerHTML = tasks.map(t => {
      const isOverdue = !t.done && t.dueDate && t.dueDate < todayIso;
      return `
      <div class="home-row">
        <input type="checkbox" ${t.done ? 'checked' : ''} onclick="submitToggleTaskDoneGlobal('${escapeHtml(t.taskId)}')" style="flex-shrink:0; width:16px; height:16px; cursor:pointer;">
        <div class="home-row-main home-row-clickable" style="flex:1;" onclick="jumpToTaskEntity('${escapeHtml(t.entityType)}', '${escapeHtml(t.entityId)}')">
          <span style="${t.done ? 'text-decoration:line-through; color:var(--color-text-faint);' : ''}">${escapeHtml(t.title)}</span>
          <span class="home-tag">${escapeHtml(t.entityType)}: ${escapeHtml(t.entityLabel || t.entityId)}</span>
        </div>
        <span class="home-row-meta ${isOverdue ? 'is-late' : ''}">${t.dueDate ? escapeHtml(t.dueDate) : ''}</span>
        <button class="btn btn-secondary btn-danger-outline" style="padding:2px 8px; font-size:11px; flex-shrink:0;" onclick="promptDeleteTaskGlobal('${escapeHtml(t.taskId)}')">Delete</button>
      </div>`;
    }).join('');
  }

  window.submitToggleTaskDoneGlobal = function(taskId) {
    google.script.run
      .withSuccessHandler(() => loadMyTasks())
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .toggleTaskDone(taskId);
  };

  window.promptDeleteTaskGlobal = function(taskId) {
    Swal.fire({
      title: 'Delete this task?',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        google.script.run
          .withSuccessHandler(() => loadMyTasks())
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteTask(taskId);
      }
    });
  };

  // Leads/Accounts/Contacts route through the Record Profile modal (no per-card link on
  // Deals yet, same limitation jumpToFollowUp already has - landing on the board is
  // still a real improvement over nothing happening).
  const TASK_ENTITY_VIEW = { Lead: 'Leads', Account: 'Accounts', Contact: 'Contacts' };
  const TASK_ENTITY_ID_COL = { Lead: 'Lead ID', Account: 'Account ID', Contact: 'Contact ID' };

  window.jumpToTaskEntity = function(entityType, entityId) {
    if (entityType === 'Deal') {
      switchTab('Deals');
      return;
    }
    const view = TASK_ENTITY_VIEW[entityType];
    if (!view) return;
    pendingTableAction = {
      view: view,
      run: (data) => {
        const idIdx = data.columns.findIndex(c => c.name === TASK_ENTITY_ID_COL[entityType]);
        const rowIndex = idIdx > -1 ? data.rows.findIndex(r => String(r[idIdx]) === String(entityId)) : -1;
        if (rowIndex > -1) {
          renderProfileModal(rowIndex);
        } else {
          Swal.fire('Error', 'Could not find that record - it may have been deleted.', 'error');
        }
      }
    };
    switchTab(view);
  };

  // --- CALENDAR (Lead/Deal follow-ups, logged Visits, and Task due dates by day) ---
  let calendarViewYear = null;
  let calendarViewMonth = null; // 0-based
  let calendarEventsCache = [];

  function loadCalendar() {
    const today = new Date();
    if (calendarViewYear === null) {
      calendarViewYear = today.getFullYear();
      calendarViewMonth = today.getMonth();
    }
    Swal.fire({ title: 'Loading calendar...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(events => { Swal.close(); calendarEventsCache = events || []; renderCalendarGrid(); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getCalendarEvents();
  }

  window.calendarShift = function(delta) {
    calendarViewMonth += delta;
    if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear--; }
    else if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear++; }
    renderCalendarGrid();
  };

  window.calendarGoToday = function() {
    const today = new Date();
    calendarViewYear = today.getFullYear();
    calendarViewMonth = today.getMonth();
    renderCalendarGrid();
  };

  function calendarIsOverdueTask(e) {
    const todayIso = new Date().toISOString().slice(0, 10);
    return e.kind === 'Task' && !e.done && e.date < todayIso;
  }

  function calendarKindClass(e) {
    if (e.kind === 'Lead Follow-up') return 'calendar-event-lead';
    if (e.kind === 'Deal Follow-up') return 'calendar-event-deal';
    if (e.kind === 'Visit') return 'calendar-event-visit';
    return 'calendar-event-task' + (calendarIsOverdueTask(e) ? ' calendar-event-overdue' : '');
  }

  function calendarDotClass(e) {
    if (e.kind === 'Lead Follow-up') return 'calendar-dot-lead';
    if (e.kind === 'Deal Follow-up') return 'calendar-dot-deal';
    if (e.kind === 'Visit') return 'calendar-dot-visit';
    return 'calendar-dot-task';
  }

  const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function renderCalendarGrid() {
    const year = calendarViewYear, month = calendarViewMonth;
    document.getElementById('calendarTitle').textContent = MONTH_LABELS[month] + ' ' + year;

    const startWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const todayIso = new Date().toISOString().slice(0, 10);

    const eventsByDate = {};
    calendarEventsCache.forEach(e => { (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e); });

    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = weekdayLabels.map(d => `<div class="calendar-weekday">${d}</div>`).join('');

    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startWeekday + 1;
      let cellYear = year, cellMonth = month, cellDay, outside = false;
      if (dayNum < 1) {
        cellDay = daysInPrevMonth + dayNum;
        cellMonth = month - 1;
        if (cellMonth < 0) { cellMonth = 11; cellYear--; }
        outside = true;
      } else if (dayNum > daysInMonth) {
        cellDay = dayNum - daysInMonth;
        cellMonth = month + 1;
        if (cellMonth > 11) { cellMonth = 0; cellYear++; }
        outside = true;
      } else {
        cellDay = dayNum;
      }
      const iso = cellYear + '-' + String(cellMonth + 1).padStart(2, '0') + '-' + String(cellDay).padStart(2, '0');
      const dayEvents = eventsByDate[iso] || [];
      const shown = dayEvents.slice(0, 3);
      const more = dayEvents.length - shown.length;
      html += `
        <div class="calendar-day${outside ? ' calendar-day-outside' : ''}${iso === todayIso ? ' calendar-day-today' : ''}" onclick="showCalendarDay('${iso}')">
          <div class="calendar-day-num">${cellDay}</div>
          <div class="calendar-day-events">
            ${shown.map(e => `<div class="calendar-event ${calendarKindClass(e)}" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>`).join('')}
            ${more > 0 ? `<div class="calendar-more">+${more} more</div>` : ''}
          </div>
        </div>`;
    }
    document.getElementById('calendarGrid').innerHTML = html;
  }

  window.showCalendarDay = function(dateStr) {
    const events = calendarEventsCache.filter(e => e.date === dateStr);
    const label = new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const html = events.length === 0
      ? '<p class="manage-columns-empty">Nothing on this day.</p>'
      : events.map(e => `
        <div class="home-row home-row-clickable" onclick="Swal.close(); jumpToTaskEntity('${escapeHtml(e.entityType)}', '${escapeHtml(e.entityId)}')">
          <div class="home-row-main"><span class="calendar-dot ${calendarDotClass(e)}"></span>${escapeHtml(e.title)}</div>
          <span class="home-tag">${escapeHtml(e.kind)}</span>
        </div>`).join('');
    Swal.fire({
      title: label,
      html: `<div style="max-height:360px; overflow-y:auto; text-align:left;">${html}</div>`,
      showConfirmButton: false,
      showCloseButton: true,
      heightAuto: false,
      scrollbarPadding: false,
      width: 460
    });
  };

  // Attachments follow a Lead when it's converted to a Deal (the backend re-keys them),
  // but there was previously no menu item on Deal cards to reach them again - this is
  // the same modal, just addressed by Deal ID/name instead of a Lead row.
  window.openAttachmentsModalForDeal = function(e, dealId) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));

    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === 'Deal ID');
    const nameIdx = columns.findIndex(c => c.name === 'Deal Name');
    const row = idIdx > -1 ? window.currentTableData.rows.find(r => String(r[idIdx]) === String(dealId)) : null;
    const dealLabel = row && nameIdx > -1 ? row[nameIdx] : 'this deal';

    openAttachmentsModalFor('Deal', dealId, dealLabel);
  };

  function openAttachmentsModalFor(entityType, entityId, entityLabel) {
    Swal.fire({ title: 'Loading attachments...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(files => {
        Swal.close();
        showAttachmentsModal(entityType, entityId, entityLabel, files);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listAttachments(entityType, entityId);
  }

  // --- RECORD PROFILE (all fields at a glance + attachments in one place, instead of
  // scrolling a wide table row and hunting for a separate Attachments action) ---
  function getColVal(row, columns, name) {
    const idx = columns.findIndex(c => c.name === name);
    return idx > -1 ? (row[idx] || '') : '';
  }

  const PROFILE_ENTITY_CONFIG = {
    Leads: {
      entityType: 'Lead', idCol: 'Lead ID',
      getTitle: (row, cols) => getColVal(row, cols, 'Company') || 'Untitled',
    },
    Accounts: {
      entityType: 'Account', idCol: 'Account ID',
      getTitle: (row, cols) => getColVal(row, cols, 'Account Name') || 'Untitled',
    },
    Contacts: {
      entityType: 'Contact', idCol: 'Contact ID',
      // This schema has no combined "Name" field, only First Name/Last Name (same gap
      // fixed for Lead conversion earlier) - compose it, with "Name" as a fallback for
      // a Contacts sheet that does use a combined field.
      getTitle: (row, cols) => {
        const combined = (getColVal(row, cols, 'First Name') + ' ' + getColVal(row, cols, 'Last Name')).trim();
        return combined || getColVal(row, cols, 'Name') || 'Untitled';
      },
    },
  };

  window.openRecordProfile = function(e, rowIndex) {
    e.preventDefault();
    document.querySelectorAll('.action-menu-content').forEach(el => el.classList.remove('show'));
    renderProfileModal(rowIndex);
  };

  // Rebuilds the whole profile modal from scratch (fields + a fresh attachments
  // fetch). Used both for the initial open and to "return" to the profile after a
  // delete/upload - this Swal shim doesn't stack modals, so the confirm-delete dialog
  // fully replaces the profile's DOM (including #profile-attachments-list), and just
  // patching that element in place silently no-ops once it's gone.
  function renderProfileModal(rowIndex) {
    const config = PROFILE_ENTITY_CONFIG[window.currentView];
    if (!config) return;

    const rowData = window.currentTableData.rows[rowIndex];
    const columns = window.currentTableData.columns;
    const idIdx = columns.findIndex(c => c.name === config.idCol);
    const entityId = idIdx > -1 ? rowData[idIdx] : null;
    const title = config.getTitle(rowData, columns);

    if (!entityId) { Swal.fire('Error', `Could not determine the ${config.idCol} for this row.`, 'error'); return; }

    const fieldsHtml = buildProfileFieldsHtml(rowData, columns, rowIndex);

    Swal.fire({
      title: escapeHtml(title),
      html: `
        <div class="profile-fields-grid">${fieldsHtml}</div>
        <div class="profile-attachments-section">
          <h4 class="profile-section-title">Attachments</h4>
          <div id="profile-attachments-list">Loading...</div>
          <input type="file" id="profile-attachments-input" multiple style="width:100%; margin-top:10px;">
          <p style="font-size:11px; color:#a0aabf; margin-top:6px;">Max ${MAX_ATTACHMENT_MB}MB per file.</p>
        </div>
      `,
      width: 640,
      showConfirmButton: false,
      showCloseButton: true,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => {
        loadProfileAttachments(config.entityType, entityId, rowIndex);
        document.getElementById('profile-attachments-input').addEventListener('change', (ev) => handleProfileAttachmentFilesSelected(ev, config.entityType, entityId, rowIndex));
      }
    });
  }

  // Every field is click-to-edit, same interaction as the main table's cells
  // (startCellEdit) - kept as its own implementation since the DOM shape here
  // (label-above-value divs) differs from a table cell, but it saves through the
  // exact same updateCellData RPC.
  function buildProfileFieldsHtml(rowData, columns, rowIndex) {
    return columns
      .map((c, idx) => ({ col: c, idx }))
      .filter(({ col }) => !isIdColumn(col.name))
      .map(({ col, idx }) => {
        const val = rowData[idx];
        return `<div class="profile-field">
          <div class="profile-field-label">${escapeHtml(col.name)}</div>
          <div class="profile-field-value" onclick="startProfileFieldEdit(this, ${rowIndex}, ${idx})">${formatProfileFieldValue(val)}</div>
        </div>`;
      }).join('');
  }

  function formatProfileFieldValue(val) {
    const str = (val === null || val === undefined) ? '' : String(val);
    return str.trim() === '' ? '<span class="profile-field-empty">—</span>' : escapeHtml(str);
  }

  window.startProfileFieldEdit = function(el, rowIndex, colIndex) {
    const col = window.currentTableData.columns[colIndex];
    const raw = window.currentTableData.rows[rowIndex][colIndex];
    const original = (raw === null || raw === undefined) ? '' : String(raw);

    let editor;
    if (col.type === 'dropdown') {
      editor = document.createElement('select');
      editor.className = 'profile-field-input';
      const blank = document.createElement('option');
      blank.value = '';
      editor.appendChild(blank);
      (col.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === original) o.selected = true;
        editor.appendChild(o);
      });
    } else if (col.type === 'date') {
      editor = document.createElement('input');
      editor.type = 'date';
      editor.className = 'profile-field-input';
      editor.value = original;
    } else {
      editor = document.createElement('input');
      editor.type = 'text';
      editor.className = 'profile-field-input';
      editor.value = original;
    }

    el.innerHTML = '';
    el.removeAttribute('onclick');
    el.appendChild(editor);
    editor.focus();
    if (editor.select) editor.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const newVal = normalizeDateInput(col.name, editor.value);
      window.currentTableData.rows[rowIndex][colIndex] = newVal;
      renderProfileFieldView(el, rowIndex, colIndex);
      if (newVal !== original) {
        google.script.run
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .updateCellData(window.currentView, rowIndex, col.name, newVal);
      }
    };
    const cancel = () => {
      settled = true;
      renderProfileFieldView(el, rowIndex, colIndex);
    };

    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); editor.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
  };

  function renderProfileFieldView(el, rowIndex, colIndex) {
    const val = window.currentTableData.rows[rowIndex][colIndex];
    el.innerHTML = formatProfileFieldValue(val);
    el.setAttribute('onclick', `startProfileFieldEdit(this, ${rowIndex}, ${colIndex})`);
  }

  function loadProfileAttachments(entityType, entityId, rowIndex) {
    google.script.run
      .withSuccessHandler(files => {
        const list = document.getElementById('profile-attachments-list');
        if (list) list.innerHTML = renderAttachmentsListHtml(files, id => `profileDeleteAttachment('${id}', ${rowIndex})`);
      })
      .withFailureHandler(err => {
        const list = document.getElementById('profile-attachments-list');
        if (list) list.innerHTML = `<p style="color:#d93025; font-size:13px;">${escapeHtml(err.message)}</p>`;
      })
      .listAttachments(entityType, entityId);
  }

  function handleProfileAttachmentFilesSelected(e, entityType, entityId, rowIndex) {
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;

    const oversized = fileList.filter(f => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
    if (oversized.length > 0) {
      Swal.fire({ title: 'File too large', text: oversizedFilesMessage(oversized), icon: 'error', heightAuto: false, scrollbarPadding: false })
        .then(() => renderProfileModal(rowIndex));
      return;
    }

    const list = document.getElementById('profile-attachments-list');
    if (list) list.innerHTML = `Uploading ${fileList.length > 1 ? fileList.length + ' files' : 'file'}...`;

    Promise.all(fileList.map(f => readFileAsBase64(f))).then(encodedFiles => {
      google.script.run
        .withSuccessHandler(() => { renderProfileModal(rowIndex); })
        .withFailureHandler(err => Swal.fire('Error', err.message, 'error').then(() => renderProfileModal(rowIndex)))
        .uploadAttachments(entityType, entityId, encodedFiles);
    }).catch(() => {
      Swal.fire('Error', 'Could not read one or more files.', 'error').then(() => renderProfileModal(rowIndex));
    });
  }

  window.profileDeleteAttachment = function(attachmentId, rowIndex) {
    Swal.fire({
      title: 'Delete Attachment?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        google.script.run
          .withSuccessHandler(() => { renderProfileModal(rowIndex); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error').then(() => renderProfileModal(rowIndex)))
          .deleteAttachment(attachmentId);
      } else {
        renderProfileModal(rowIndex);
      }
    });
  };

  function renderAttachmentsListHtml(files, buildDeleteOnclick) {
    buildDeleteOnclick = buildDeleteOnclick || (id => `promptDeleteAttachment('${id}')`);
    if (!files || files.length === 0) {
      return '<p style="color: #a0aabf; text-align: center; padding: 20px;">No attachments yet.</p>';
    }
    return files.map(f => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #e1e5eb;">
        <div style="min-width:0; margin-right:10px;">
          <a href="${escapeHtml(f.driveFileUrl)}" target="_blank" rel="noopener" style="font-size:13px; color:#11141a; text-decoration:none; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(f.fileName)}">${escapeHtml(f.fileName)}</a>
          <span style="font-size:11px; color:#a0aabf;">${formatFileSize(f.size)}</span>
        </div>
        <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px; color:#d93025; border-color:#fad2d0; background-color:#fff; flex-shrink:0;" onclick="${buildDeleteOnclick(escapeHtml(f.attachmentId))}">Delete</button>
      </div>`).join('');
  }

  function showAttachmentsModal(entityType, entityId, entityLabel, files) {
    currentAttachmentsContext = { entityType: entityType, entityId: entityId, entityLabel: entityLabel, files: files };

    Swal.fire({
      title: `Attachments - ${entityLabel}`,
      html: `
        <div id="attachments-list" style="text-align:left; max-height:280px; overflow-y:auto; margin-bottom:15px;">
          ${renderAttachmentsListHtml(files)}
        </div>
        <input type="file" id="attachments-file-input" multiple style="width:100%;">
        <p style="font-size:11px; color:#a0aabf; margin-top:8px;">Max ${MAX_ATTACHMENT_MB}MB per file.</p>
      `,
      showConfirmButton: false,
      showCloseButton: true,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => {
        document.getElementById('attachments-file-input').addEventListener('change', handleAttachmentFilesSelected);
      }
    });
  }

  function refreshAttachmentsModal() {
    if (!currentAttachmentsContext) return;
    const { entityType, entityId, entityLabel } = currentAttachmentsContext;
    google.script.run
      .withSuccessHandler(files => showAttachmentsModal(entityType, entityId, entityLabel, files))
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listAttachments(entityType, entityId);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const commaIdx = dataUrl.indexOf(',');
        const base64Data = commaIdx > -1 ? dataUrl.substring(commaIdx + 1) : dataUrl;
        resolve({ fileName: file.name, mimeType: file.type, base64Data: base64Data });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function handleAttachmentFilesSelected(e) {
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;

    const { entityType, entityId, entityLabel } = currentAttachmentsContext;

    const oversized = fileList.filter(f => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
    if (oversized.length > 0) {
      Swal.fire({ title: 'File too large', text: oversizedFilesMessage(oversized), icon: 'error', heightAuto: false, scrollbarPadding: false })
        .then(() => showAttachmentsModal(entityType, entityId, entityLabel, currentAttachmentsContext.files));
      return;
    }

    Swal.fire({ title: `Uploading ${fileList.length > 1 ? fileList.length + ' files' : 'file'}...`, allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });

    Promise.all(fileList.map(file => readFileAsBase64(file))).then(encodedFiles => {
      google.script.run
        .withSuccessHandler(files => {
          Swal.close();
          showAttachmentsModal(entityType, entityId, entityLabel, files);
        })
        .withFailureHandler(err => {
          Swal.fire('Error', err.message, 'error').then(() => refreshAttachmentsModal());
        })
        .uploadAttachments(entityType, entityId, encodedFiles);
    }).catch(() => {
      Swal.fire('Error', 'Could not read one or more files.', 'error').then(() => refreshAttachmentsModal());
    });
  }

  window.promptDeleteAttachment = function(attachmentId) {
    Swal.fire({
      title: 'Delete Attachment?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        const { entityType, entityId, entityLabel } = currentAttachmentsContext;
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(files => {
            Swal.close();
            showAttachmentsModal(entityType, entityId, entityLabel, files);
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteAttachment(attachmentId);
      }
    });
  };

  // --- ANALYTICS ---
  let analyticsCharts = {};
  let analyticsOptionsLoaded = false;

  // Turn the date-range preset into concrete YYYY-MM-DD start/end using the browser
  // clock. 'all' returns nulls (server treats that as all-time, no deltas).
  function resolveDateRange(preset) {
    const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    if (preset === 'this_month') return { startDate: fmt(new Date(y, m, 1)), endDate: fmt(new Date(y, m + 1, 0)) };
    if (preset === 'last_month') return { startDate: fmt(new Date(y, m - 1, 1)), endDate: fmt(new Date(y, m, 0)) };
    if (preset === 'this_quarter') { const q = Math.floor(m / 3) * 3; return { startDate: fmt(new Date(y, q, 1)), endDate: fmt(new Date(y, q + 3, 0)) }; }
    if (preset === 'this_year') return { startDate: fmt(new Date(y, 0, 1)), endDate: fmt(new Date(y, 11, 31)) };
    return { startDate: null, endDate: null };
  }

  function loadAnalytics() {
    const preset = document.getElementById('analyticsDateRange').value;
    const range = resolveDateRange(preset);
    const opts = {
      rep: document.getElementById('analyticsRep').value || '',
      territory: document.getElementById('analyticsTerritory').value || '',
      startDate: range.startDate,
      endDate: range.endDate
    };
    Swal.fire({ title: 'Loading Analytics...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(data => {
        Swal.close();
        renderAnalytics(data);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getAnalyticsData(opts);
  }

  function formatCurrency(value) {
    const num = parseFloat(value);
    if (value === null || value === undefined || isNaN(num)) return '—';
    return '₱' + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return Math.round(value * 100) + '%';
  }

  // Fill the rep/territory dropdowns once from the data's filterOptions, preserving the
  // current selection. Runs on the first render (and stays put after) so re-fetching on
  // a filter change doesn't wipe the choice.
  function populateAnalyticsFilters(filterOptions) {
    const build = (selectId, values, allLabel) => {
      const sel = document.getElementById(selectId);
      const current = sel.value;
      let html = `<option value="">${allLabel}</option>`;
      values.forEach(v => { html += `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`; });
      html += `<option value="(Unassigned)">(Unassigned)</option>`;
      sel.innerHTML = html;
      sel.value = current; // keep selection if still valid
    };
    if (window.isAdmin) {
      build('analyticsRep', (filterOptions && filterOptions.reps) || [], 'All reps');
    } else {
      // getAnalyticsData already forces this viewer's own rep filter server-side
      // regardless of what's selected here - lock the control so the UI doesn't show
      // a choice that isn't real, rather than a working-looking dropdown that
      // silently has no effect (and that would otherwise list every other rep's name).
      const repSel = document.getElementById('analyticsRep');
      repSel.innerHTML = '<option value="" selected>Just me</option>';
      repSel.disabled = true;
    }
    build('analyticsTerritory', (filterOptions && filterOptions.territories) || [], 'All territories');
    analyticsOptionsLoaded = true;
  }

  // period tile: value + a delta chip vs the previous equal-length window.
  function renderDelta(deltaElId, cur, prev, hasWindow) {
    const el = document.getElementById(deltaElId);
    if (!hasWindow || prev === null || prev === undefined) { el.innerText = ''; el.className = 'kpi-delta'; return; }
    const c = Number(cur) || 0, p = Number(prev) || 0;
    if (p === 0) {
      el.innerText = c > 0 ? 'New vs last period' : 'No change';
      el.className = 'kpi-delta ' + (c > 0 ? 'up' : 'flat');
      return;
    }
    const pct = Math.round(((c - p) / p) * 100);
    const up = pct >= 0;
    el.innerText = (up ? '▲ ' : '▼ ') + Math.abs(pct) + '% vs last period';
    el.className = 'kpi-delta ' + (pct === 0 ? 'flat' : (up ? 'up' : 'down'));
  }

  function renderAnalytics(data) {
    if (!analyticsOptionsLoaded) populateAnalyticsFilters(data.filterOptions);

    const kpis = data.kpis;
    const prev = data.kpisPrev;
    const hasWindow = data.hasWindow;

    document.getElementById('kpi-total-leads').innerText = kpis.totalLeads;
    document.getElementById('kpi-won-value').innerText = formatCurrency(kpis.totalWonValue);
    document.getElementById('kpi-win-rate').innerText = formatPercent(kpis.winRate);
    document.getElementById('kpi-win-rate-sub').innerText = (kpis.closedWonCount + kpis.closedLostCount) > 0
      ? `${kpis.closedWonCount} won / ${kpis.closedLostCount} lost` : '';
    document.getElementById('kpi-open-deals').innerText = kpis.openDealCount;
    document.getElementById('kpi-pipeline-value').innerText = formatCurrency(kpis.totalPipelineValue);
    document.getElementById('kpi-avg-deal-size').innerText = formatCurrency(kpis.averageDealSize);

    const visits = data.visits || { inPeriod: 0, overdueCount: 0, overdue: [], perMonth: [] };
    document.getElementById('kpi-visits-30').innerText = visits.inPeriod;
    document.getElementById('kpi-overdue').innerText = visits.overdueCount;

    // Deltas on the period tiles (win-rate delta is in percentage points).
    renderDelta('kpi-total-leads-delta', kpis.totalLeads, prev && prev.totalLeads, hasWindow);
    renderDelta('kpi-won-value-delta', kpis.totalWonValue, prev && prev.totalWonValue, hasWindow);
    renderDelta('kpi-visits-delta', kpis.visits, prev && prev.visits, hasWindow);
    // Win rate: show point difference rather than % change of a %.
    const wrEl = document.getElementById('kpi-win-rate-delta');
    if (hasWindow && prev && prev.winRate !== null && prev.winRate !== undefined && kpis.winRate !== null) {
      const pts = Math.round((kpis.winRate - prev.winRate) * 100);
      const up = pts >= 0;
      wrEl.innerText = (up ? '▲ ' : '▼ ') + Math.abs(pts) + ' pts vs last period';
      wrEl.className = 'kpi-delta ' + (pts === 0 ? 'flat' : (up ? 'up' : 'down'));
    } else { wrEl.innerText = ''; wrEl.className = 'kpi-delta'; }

    renderDealsByStageChart(data.dealsByStage);
    renderWinLossChart(kpis.closedWonCount, kpis.closedLostCount);
    renderCategoryPieChart('chart-leads-by-source', data.leadsBySource, 'source');
    renderCategoryBarChart('chart-leads-by-status', data.leadsByStatus, 'status');
    renderDealsClosedPerMonthChart(data.dealsClosedPerMonth);
    renderVisitsPerMonthChart(visits.perMonth);
    renderOverdueList(visits.overdue, visits.overdueCount);
  }

  ['analyticsDateRange', 'analyticsRep', 'analyticsTerritory'].forEach(id => {
    document.getElementById(id).addEventListener('change', loadAnalytics);
  });

  function renderVisitsPerMonthChart(perMonth) {
    const canvasId = 'chart-visits-per-month';
    destroyChart(canvasId);
    const hasData = perMonth && perMonth.length > 0;
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: perMonth.map(m => m.month),
        datasets: [{ label: 'Visits', data: perMonth.map(m => m.count), backgroundColor: '#0088ff' }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { precision: 0 } } }
      }
    });
  }

  function renderOverdueList(overdue, totalCount) {
    const el = document.getElementById('overdueList');
    if (!overdue || overdue.length === 0) {
      el.innerHTML = '<p class="chart-empty-placeholder">Every account has been visited within the last 30 days.</p>';
      return;
    }
    let html = overdue.map(a => {
      const status = a.daysSince === null
        ? '<span class="overdue-never">Never visited</span>'
        : `<span class="overdue-days">${a.daysSince} days ago</span>`;
      return `
        <div class="overdue-row">
          <span class="overdue-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
          ${status}
        </div>`;
    }).join('');
    if (totalCount > overdue.length) {
      html += `<div class="overdue-more">+ ${totalCount - overdue.length} more not shown</div>`;
    }
    el.innerHTML = html;
  }

  // Re-visiting the Analytics tab re-fetches and re-renders from scratch (same
  // no-caching convention as the rest of the app) - Chart.js errors/leaks if a canvas
  // is reused without destroying its previous instance first, so track them by id.
  function destroyChart(canvasId) {
    if (analyticsCharts[canvasId]) {
      analyticsCharts[canvasId].destroy();
      delete analyticsCharts[canvasId];
    }
  }

  function showChartOrEmpty(canvasId, hasData) {
    const canvas = document.getElementById(canvasId);
    const wrap = canvas.parentElement;
    let placeholder = wrap.querySelector('.chart-empty-placeholder');
    if (!hasData) {
      canvas.style.display = 'none';
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'chart-empty-placeholder';
        placeholder.innerText = 'No data yet';
        wrap.appendChild(placeholder);
      }
      placeholder.style.display = 'block';
    } else {
      canvas.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    }
  }

  function renderDealsByStageChart(dealsByStage) {
    const canvasId = 'chart-deals-by-stage';
    destroyChart(canvasId);
    const hasData = dealsByStage.some(s => s.count > 0);
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: dealsByStage.map(s => s.stage),
        datasets: [{ label: 'Deals', data: dealsByStage.map(s => s.count), backgroundColor: '#0088ff' }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { precision: 0 } } }
      }
    });
  }

  function renderWinLossChart(wonCount, lostCount) {
    const canvasId = 'chart-win-loss';
    destroyChart(canvasId);
    const hasData = (wonCount + lostCount) > 0;
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'doughnut',
      data: {
        labels: ['Won', 'Lost'],
        datasets: [{ data: [wonCount, lostCount], backgroundColor: ['#0088ff', '#d93025'] }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  function capToTopN(items, keyName, n) {
    const sorted = items.slice().sort((a, b) => b.count - a.count);
    if (sorted.length <= n) return sorted;
    const top = sorted.slice(0, n);
    const otherCount = sorted.slice(n).reduce((sum, item) => sum + item.count, 0);
    const otherItem = {};
    otherItem[keyName] = 'Other';
    otherItem.count = otherCount;
    top.push(otherItem);
    return top;
  }

  function renderCategoryPieChart(canvasId, items, keyName) {
    destroyChart(canvasId);
    const hasData = items.length > 0 && items.some(i => i.count > 0);
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    const capped = capToTopN(items, keyName, 5);
    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'pie',
      data: {
        labels: capped.map(i => i[keyName]),
        datasets: [{ data: capped.map(i => i.count), backgroundColor: ['#0088ff', '#5c6673', '#a0aabf', '#0d1219', '#e1e5eb', '#d93025'] }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  function renderCategoryBarChart(canvasId, items, keyName) {
    destroyChart(canvasId);
    const hasData = items.length > 0 && items.some(i => i.count > 0);
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    const capped = capToTopN(items, keyName, 8);
    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: capped.map(i => i[keyName]),
        datasets: [{ label: 'Leads', data: capped.map(i => i.count), backgroundColor: '#0088ff' }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { precision: 0 } } }
      }
    });
  }

  function renderDealsClosedPerMonthChart(dealsClosedPerMonth) {
    const canvasId = 'chart-deals-closed-per-month';
    destroyChart(canvasId);
    const hasData = dealsClosedPerMonth.length > 0;
    showChartOrEmpty(canvasId, hasData);
    if (!hasData) return;

    analyticsCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels: dealsClosedPerMonth.map(m => m.month),
        datasets: [
          { label: 'Won', data: dealsClosedPerMonth.map(m => m.wonCount), borderColor: '#0088ff', backgroundColor: '#0088ff', tension: 0.2 },
          { label: 'Lost', data: dealsClosedPerMonth.map(m => m.lostCount), borderColor: '#d93025', backgroundColor: '#d93025', tension: 0.2 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { ticks: { precision: 0 } } }
      }
    });
  }

  // --- DOCUMENTS (Drive file manager) ---
  let currentDocFolderId = null;
  // id -> {name, isFolder, url}. Only safe Drive IDs (which are [A-Za-z0-9_-]) are ever
  // interpolated into inline onclick handlers; names/urls are looked up from here, so a
  // folder/file called "John's Notes" can't break the generated HTML/JS.
  let docItemsById = {};

  function loadDocuments(folderId) {
    Swal.fire({ title: 'Loading Documents...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(data => {
        Swal.close();
        renderDocuments(data);
      })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getDocuments(folderId || null);
  }

  function renderDocuments(data) {
    currentDocFolderId = data.folderId;
    docItemsById = {};

    // Breadcrumbs - every crumb but the last is a clickable ancestor folder.
    const crumbs = data.breadcrumbs.map((c, i) => {
      const isLast = i === data.breadcrumbs.length - 1;
      if (isLast) return `<span class="doc-crumb-current">${escapeHtml(c.name)}</span>`;
      return `<span class="doc-crumb" onclick="openDocFolder('${c.id}')">${escapeHtml(c.name)}</span><span class="doc-crumb-sep">/</span>`;
    }).join('');
    document.getElementById('docBreadcrumbs').innerHTML = crumbs;

    const grid = document.getElementById('docGrid');
    if (data.folders.length === 0 && data.files.length === 0) {
      grid.innerHTML = '<div class="doc-empty">This folder is empty. Use <b>New Folder</b> or <b>Upload Files</b> to add something.</div>';
      return;
    }

    let html = '';
    data.folders.forEach(f => {
      docItemsById[f.id] = { name: f.name, isFolder: true, url: null };
      html += `
        <div class="doc-tile" onclick="openDocItem('${f.id}')">
          <button class="doc-tile-menu-btn" onclick="openDocItemMenu(event, '${f.id}')">⋮</button>
          <div class="doc-tile-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#0088ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3a1.5 1.5 0 0 1 1.06.44l1.2 1.2H19.5A1.5 1.5 0 0 1 21 9.14V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z" fill="#e8f3ff"/></svg>
          </div>
          <div class="doc-tile-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="doc-tile-meta">Folder</div>
        </div>`;
    });
    data.files.forEach(f => {
      docItemsById[f.id] = { name: f.name, isFolder: false, url: f.url };
      html += `
        <div class="doc-tile" onclick="openDocItem('${f.id}')">
          <button class="doc-tile-menu-btn" onclick="openDocItemMenu(event, '${f.id}')">⋮</button>
          <div class="doc-tile-icon">${fileIconSvg(f.mimeType, f.name)}</div>
          <div class="doc-tile-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="doc-tile-meta">${formatFileSize(f.size)}</div>
        </div>`;
    });
    grid.innerHTML = html;
  }

  function fileIconSvg(mimeType, name) {
    const mt = (mimeType || '').toLowerCase();
    const ext = (name || '').split('.').pop().toLowerCase();
    let color = '#5c6673';
    if (mt.indexOf('image') > -1) color = '#16a34a';
    else if (mt.indexOf('pdf') > -1 || ext === 'pdf') color = '#d93025';
    else if (mt.indexOf('spreadsheet') > -1 || ['xls','xlsx','csv'].indexOf(ext) > -1) color = '#15803d';
    else if (mt.indexOf('document') > -1 || ['doc','docx'].indexOf(ext) > -1) color = '#0088ff';
    else if (mt.indexOf('presentation') > -1 || ['ppt','pptx'].indexOf(ext) > -1) color = '#ea580c';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V19a1.2 1.2 0 0 1-1.2 1.2H7A1.2 1.2 0 0 1 5.8 19V4.7A1.2 1.2 0 0 1 7 3.5Z" fill="${color}1a"/><path d="M14 3.5V8h4"/></svg>`;
  }

  window.openDocFolder = function(folderId) {
    loadDocuments(folderId);
  };

  // Single click on a tile: folders navigate in, files open in a new tab.
  window.openDocItem = function(itemId) {
    const item = docItemsById[itemId];
    if (!item) return;
    if (item.isFolder) openDocFolder(itemId);
    else if (item.url) window.open(item.url, '_blank');
  };

  window.openDocItemMenu = function(e, itemId) {
    e.stopPropagation();
    const item = docItemsById[itemId];
    if (!item) return;

    Swal.fire({
      title: item.name,
      showCancelButton: true,
      showDenyButton: true,
      confirmButtonText: item.isFolder ? 'Open' : 'Open File',
      denyButtonText: 'Rename',
      cancelButtonText: 'Close',
      confirmButtonColor: '#0088ff',
      denyButtonColor: '#5c6673',
      heightAuto: false,
      scrollbarPadding: false,
      footer: `<a href="#" style="color:#d93025; text-decoration:none; font-size:13px;" onclick="promptDeleteDocItem('${itemId}'); return false;">Delete ${item.isFolder ? 'folder' : 'file'}</a>`
    }).then(result => {
      if (result.isConfirmed) {
        openDocItem(itemId);
      } else if (result.isDenied) {
        promptRenameDocItem(itemId);
      }
    });
  };

  window.promptRenameDocItem = function(itemId) {
    const item = docItemsById[itemId];
    if (!item) return;
    Swal.fire({
      title: 'Rename',
      input: 'text',
      inputValue: item.name,
      showCancelButton: true,
      confirmButtonText: 'Rename',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      inputValidator: (v) => (!v || !v.trim()) ? 'A name is required' : undefined
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Renaming...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDocuments(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .renameDocItem(itemId, item.isFolder, result.value.trim(), currentDocFolderId);
      }
    });
  };

  window.promptDeleteDocItem = function(itemId) {
    const item = docItemsById[itemId];
    if (!item) return;
    Swal.fire({
      title: `Delete ${item.isFolder ? 'folder' : 'file'}?`,
      html: item.isFolder
        ? `<b>${escapeHtml(item.name)}</b> and everything inside it will be deleted. You won't be able to revert this!`
        : `<b>${escapeHtml(item.name)}</b> will be deleted. You won't be able to revert this!`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDocuments(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteDocItem(itemId, item.isFolder, currentDocFolderId);
      }
    });
  };

  document.getElementById('newFolderBtn').addEventListener('click', () => {
    Swal.fire({
      title: 'New Folder',
      input: 'text',
      inputPlaceholder: 'Folder name',
      showCancelButton: true,
      confirmButtonText: 'Create',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      inputValidator: (v) => (!v || !v.trim()) ? 'A folder name is required' : undefined
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Creating folder...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(data => { Swal.close(); renderDocuments(data); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .createDocFolder(currentDocFolderId, result.value.trim());
      }
    });
  });

  document.getElementById('uploadDocBtn').addEventListener('click', () => {
    document.getElementById('docFileInput').click();
  });

  document.getElementById('docFileInput').addEventListener('change', (e) => {
    const fileList = Array.from(e.target.files || []);
    e.target.value = ''; // reset so re-selecting the same file re-triggers change
    if (fileList.length === 0) return;

    const oversized = fileList.filter(f => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
    if (oversized.length > 0) {
      Swal.fire({ title: 'File too large', text: oversizedFilesMessage(oversized), icon: 'error', heightAuto: false, scrollbarPadding: false });
      return;
    }

    const targetFolderId = currentDocFolderId;
    Swal.fire({ title: `Uploading ${fileList.length > 1 ? fileList.length + ' files' : 'file'}...`, allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    Promise.all(fileList.map(f => readFileAsBase64(f))).then(encodedFiles => {
      google.script.run
        .withSuccessHandler(data => { Swal.close(); renderDocuments(data); })
        .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
        .uploadDocuments(targetFolderId, encodedFiles);
    }).catch(() => {
      Swal.fire('Error', 'Could not read one or more files.', 'error');
    });
  });

  // --- HOME / TODAY DASHBOARD ---
  function loadHome() {
    Swal.fire({ title: 'Loading...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
    google.script.run
      .withSuccessHandler(d => { Swal.close(); renderHome(d); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .getHomeData();
  }

  function renderHome(d) {
    const pw = d.pastWeek || {};
    document.getElementById('home-leads').innerText = pw.leads || 0;
    document.getElementById('home-visits').innerText = pw.visits || 0;
    document.getElementById('home-won').innerText = pw.dealsWon || 0;
    document.getElementById('home-won-value').innerText = formatCurrency(pw.wonValue || 0);

    document.getElementById('home-followups-count').innerText = d.followUps.count;
    document.getElementById('home-followups').innerHTML = d.followUps.items.length
      ? d.followUps.items.map(f => `
        <div class="home-row home-row-clickable" onclick="jumpToFollowUp('${escapeHtml(f.entity)}', '${escapeHtml(f.name).replace(/'/g, "\\'")}')">
          <div class="home-row-main"><span class="home-tag">${escapeHtml(f.entity)}</span> ${escapeHtml(f.name)}</div>
          <span class="home-row-meta ${f.daysOverdue > 0 ? 'is-late' : ''}">${f.daysOverdue > 0 ? f.daysOverdue + 'd overdue' : 'due today'} · ${escapeHtml(f.date)}</span>
        </div>`).join('')
      : '<p class="home-empty">Nothing due — you\'re clear.</p>';

    document.getElementById('home-overdue-count').innerText = d.overdueVisits.count;
    document.getElementById('home-overdue').innerHTML = d.overdueVisits.items.length
      ? d.overdueVisits.items.map(a => `
        <div class="home-row home-row-clickable" onclick="jumpToAccountVisit('${escapeHtml(a.name).replace(/'/g, "\\'")}')">
          <div class="home-row-main">${escapeHtml(a.name)}</div>
          <span class="home-row-meta ${a.daysSince === null ? 'is-never' : 'is-late'}">${a.daysSince === null ? 'never visited' : a.daysSince + ' days ago'}</span>
        </div>`).join('')
      : '<p class="home-empty">All accounts visited within 30 days.</p>';

    document.getElementById('home-stale-count').innerText = d.staleBids.count;
    document.getElementById('home-stale').innerHTML = d.staleBids.items.length
      ? d.staleBids.items.map(b => `
        <div class="home-row home-row-clickable" onclick="switchTab('Deals')">
          <div class="home-row-main">${escapeHtml(b.name)}${b.account ? ' <span class="home-sub">· ' + escapeHtml(b.account) + '</span>' : ''}</div>
          <span class="home-row-meta is-late">${b.daysOpen}d open</span>
        </div>`).join('')
      : '<p class="home-empty">No bids sitting too long.</p>';

    const birthdays = d.upcomingBirthdays || { count: 0, items: [] };
    document.getElementById('home-birthdays-count').innerText = birthdays.count;
    document.getElementById('home-birthdays').innerHTML = birthdays.items.length
      ? birthdays.items.map(b => `
        <div class="home-row home-row-clickable" onclick="jumpToContact('${escapeHtml(b.name).replace(/'/g, "\\'")}')">
          <div class="home-row-main">${escapeHtml(b.name)}</div>
          <span class="home-row-meta ${b.daysUntil === 0 ? 'is-late' : ''}">${b.daysUntil === 0 ? 'today' : b.daysUntil === 1 ? 'tomorrow' : 'in ' + b.daysUntil + ' days'} · ${escapeHtml(b.date)}</span>
        </div>`).join('')
      : '<p class="home-empty">No birthdays in the next 30 days.</p>';
  }

  // Home dashboard rows previously did nothing when tapped - a rep saw "overdue for a
  // visit" but had to remember the name, switch tabs, and search for it themselves.

  window.jumpToFollowUp = function(entity, name) {
    if (entity === 'Deal') {
      switchTab('Deals'); // Kanban has no per-card search yet; landing on the board is still a real improvement over nothing happening.
      return;
    }
    pendingTableSearch = { view: 'Leads', query: name };
    switchTab('Leads');
  };

  window.jumpToContact = function(name) {
    pendingTableSearch = { view: 'Contacts', query: name };
    switchTab('Contacts');
  };

  window.jumpToAccountVisit = function(accountName) {
    pendingTableAction = {
      view: 'Accounts',
      run: (data) => {
        const nameIdx = data.columns.findIndex(c => c.name === 'Account Name');
        const rowIndex = nameIdx > -1 ? data.rows.findIndex(r => r[nameIdx] === accountName) : -1;
        if (rowIndex > -1) {
          promptLogVisit({ preventDefault: () => {} }, rowIndex);
        } else {
          Swal.fire('Error', `Could not find "${accountName}" in Accounts.`, 'error');
        }
      }
    };
    switchTab('Accounts');
  };

  // Duplicate detect & merge UI removed (backend findDuplicateGroups/mergeRecords in
  // logic.py are untouched if this needs to come back later).

  // --- USER SETTINGS (admin only - the tab/button only exist in the DOM for admins;
  // the backend also rejects these RPCs from a non-admin session either way) ---

  function loadUsers() {
    Swal.fire({
      title: 'Loading users...',
      allowOutsideClick: false,
      heightAuto: false,
      scrollbarPadding: false,
      didOpen: () => { Swal.showLoading(); }
    });
    google.script.run
      .withSuccessHandler(list => { Swal.close(); renderUsersTable(list); })
      .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
      .listUsers();
  }

  function renderUsersTable(list) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    tbody.innerHTML = (list || []).map(u => `
      <tr>
        <td><div class="cell-view">${escapeHtml(u.username)}</div></td>
        <td><div class="cell-view${u.email ? '' : ' empty'}">${u.email ? escapeHtml(u.email) : '—'}</div></td>
        <td><div class="cell-view${u.salesRepName ? '' : ' empty'}" onclick="promptEditSalesRepName(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.salesRepName).replace(/'/g, "\\'")}')" title="Click to edit">${u.salesRepName ? escapeHtml(u.salesRepName) : '—'}</div></td>
        <td><span class="home-tag">${u.isAdmin ? 'Admin' : 'User'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary" style="padding:5px 10px; font-size:12px;" onclick="promptResetUserPassword(${u.id}, '${escapeHtml(u.username)}')">Reset Password</button>
          <button class="btn btn-secondary btn-danger-outline" style="padding:5px 10px; font-size:12px;" onclick="promptDeleteUser(${u.id}, '${escapeHtml(u.username)}')">Delete</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:#a0aabf; padding:28px; font-size:13px;">No users yet</td></tr>`;
  }

  document.getElementById('addUserBtn') && document.getElementById('addUserBtn').addEventListener('click', () => {
    Swal.fire({
      title: 'Add User',
      html: `
        <div class="form-field">
          <label class="form-label">Username</label>
          <input id="new-user-username" class="swal2-input swal-field-input" placeholder="e.g. jsmith" autocomplete="off">
        </div>
        <div class="form-field">
          <label class="form-label">Email (optional)</label>
          <input id="new-user-email" type="email" class="swal2-input swal-field-input" placeholder="jsmith@example.com" autocomplete="off">
        </div>
        <div class="form-field">
          <label class="form-label">Password</label>
          <input id="new-user-password" type="password" class="swal2-input swal-field-input" placeholder="At least 6 characters" autocomplete="new-password">
        </div>
        <div class="form-field">
          <label class="form-label">Sales Rep Name (optional)</label>
          <input id="new-user-rep-name" class="swal2-input swal-field-input" placeholder="Must match their 'Sales Rep' value on records, e.g. Juan Dela Cruz">
        </div>
        <div class="form-field" style="display:flex; align-items:center; gap:8px;">
          <input id="new-user-admin" type="checkbox" style="width:16px; height:16px; margin:0;">
          <label class="form-label" style="margin:0;" for="new-user-admin">Grant admin access</label>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Add User',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      preConfirm: () => {
        const username = document.getElementById('new-user-username').value.trim();
        const password = document.getElementById('new-user-password').value;
        if (!username) { Swal.showValidationMessage('A username is required'); return false; }
        if (!password || password.length < 6) { Swal.showValidationMessage('Password must be at least 6 characters'); return false; }
        return {
          username: username,
          email: document.getElementById('new-user-email').value.trim(),
          password: password,
          isAdmin: document.getElementById('new-user-admin').checked,
          salesRepName: document.getElementById('new-user-rep-name').value.trim()
        };
      }
    }).then(result => {
      if (result.isConfirmed) {
        const v = result.value;
        Swal.fire({ title: 'Adding user...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(list => { Swal.close(); renderUsersTable(list); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .addUser(v.username, v.email, v.password, v.isAdmin, v.salesRepName);
      }
    });
  });

  // A non-admin only sees records where "Sales Rep" matches this name (case-
  // insensitive) - left blank, their account isn't scoped at all (sees everything),
  // which is why this is editable separately from a required field at creation time.
  window.promptEditSalesRepName = function(userId, username, currentName) {
    Swal.fire({
      title: `Sales Rep Name for ${username}`,
      input: 'text',
      inputValue: currentName || '',
      inputPlaceholder: 'e.g. Juan Dela Cruz (must match their "Sales Rep" value on records)',
      showCancelButton: true,
      confirmButtonText: 'Save',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Updating...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(list => { Swal.close(); renderUsersTable(list); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .updateUserSalesRepName(userId, result.value.trim());
      }
    });
  };

  window.promptResetUserPassword = function(userId, username) {
    Swal.fire({
      title: `Reset password for ${username}`,
      input: 'password',
      inputPlaceholder: 'New password (at least 6 characters)',
      showCancelButton: true,
      confirmButtonText: 'Reset',
      confirmButtonColor: '#0088ff',
      heightAuto: false,
      scrollbarPadding: false,
      inputValidator: (v) => (!v || v.length < 6) ? 'Password must be at least 6 characters' : undefined
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Updating...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(list => {
            Swal.close();
            renderUsersTable(list);
            Swal.fire({ title: 'Password updated', icon: 'success', timer: 1400, showConfirmButton: false, heightAuto: false, scrollbarPadding: false });
          })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .updateUserPassword(userId, result.value);
      }
    });
  };

  window.promptDeleteUser = function(userId, username) {
    Swal.fire({
      title: `Delete ${username}?`,
      text: "They won't be able to log in anymore. This can't be undone.",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d93025',
      confirmButtonText: 'Delete',
      heightAuto: false,
      scrollbarPadding: false
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'Deleting...', allowOutsideClick: false, heightAuto: false, scrollbarPadding: false, didOpen: () => Swal.showLoading() });
        google.script.run
          .withSuccessHandler(list => { Swal.close(); renderUsersTable(list); })
          .withFailureHandler(err => Swal.fire('Error', err.message, 'error'))
          .deleteUser(userId);
      }
    });
  };
