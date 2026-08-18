(function () {
  "use strict";
  // ================================================================
  // Config / constants
  // ================================================================
  var GITHUB_API = "https://api.github.com";
  var TOKEN_KEY = "gh_pat_dashboard";
  var MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 Mo
  var PRIORITY_LABEL = { haute: "Haute", moyenne: "Moyenne", basse: "Basse" };
  var PRIORITY_RANK = { haute: 0, moyenne: 1, basse: 2 };
  var STATUS_LABEL = { a_faire: "À faire", en_cours: "En cours", fait: "Fait", bloque: "Bloqué" };
  var STATUS_ICON = { a_faire: "○", en_cours: "◐", fait: "✓", bloque: "⛔" };
  var STATUS_ORDER = ["a_faire", "en_cours", "fait", "bloque"];
  var CATEGORY_LABEL = { althea: "Althéa", bsm: "BSM" };
  var projects = [];
  var dataSha = null;
  var pollTimer = null;
  var state = {
    category: "all",
    priorities: new Set(["haute", "moyenne", "basse"]),
    statuses: new Set(STATUS_ORDER),
    search: "",
    sort: "priority",
    view: "cards",
    editingId: null,
    confirmDeleteId: null,
    docWarning: ""
  };
  // ================================================================
  // Small helpers
  // ================================================================
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function safeName(name) { return String(name).replace(/[^a-zA-Z0-9.-]/g, ""); }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
  }
  function fileIcon(name) {
    var ext = (String(name).split(".").pop() || "").toLowerCase();
    if (["xlsx", "xls", "csv"].indexOf(ext) !== -1) return "📊";
    if (ext === "pdf") return "📄";
    if (["ppt", "pptx"].indexOf(ext) !== -1) return "📽️";
    if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg"].indexOf(ext) !== -1) return "🖼️";
    if (["doc", "docx"].indexOf(ext) !== -1) return "📝";
    if (["zip", "rar", "7z"].indexOf(ext) !== -1) return "🗜️";
    return "📁";
  }
  function formatBytes(n) {
    n = n || 0;
    if (n < 1024) return n + " o";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " Ko";
    return (n / (1024 * 1024)).toFixed(1) + " Mo";
  }
  function decodeBase64Utf8(b64) {
    var clean = b64.replace(/\n/g, "");
    var binary = atob(clean);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  function encodeUtf8Base64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }
  function logActivity(p, text) {
    if (!p.activity) p.activity = [];
    p.activity.unshift({ date: new Date().toISOString(), text: text });
    if (p.activity.length > 40) p.activity.length = 40;
  }
  // ================================================================
  // Token storage (local only — never committed anywhere)
  // ================================================================
  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }
  // ================================================================
  // GitHub API layer
  // ================================================================
  function ghHeaders(extra) {
    return Object.assign({
      Authorization: "Bearer " + getToken(),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }, extra || {});
  }
  function ghUrl(path) {
    return GITHUB_API + "/repos/" + DATA_REPO_OWNER + "/" + DATA_REPO_NAME + "/contents/" + encodePath(path);
  }
  async function loadDataJson() {
    setSync("syncing", "Synchronisation…");
    var res = await fetch(ghUrl("data.json"), { headers: ghHeaders() });
    if (res.status === 401 || res.status === 403) {
      setSync("error", "Token invalide ou permissions insuffisantes.");
      throw new Error("auth");
    }
    if (res.status === 404) {
      var created = await createInitialDataJson();
      if (created) {
        setSync("", "data.json créé automatiquement dans le dépôt de données — sauvegarde en direct");
        return true;
      }
      setSync("error", "data.json introuvable et création impossible — vérifie que le token a bien « Contents : Read and write » sur le dépôt de données.");
      return false;
    }
    if (!res.ok) {
      setSync("error", "Erreur GitHub (" + res.status + ")");
      return false;
    }
    var json = await res.json();
    dataSha = json.sha;
    var parsed;
    try {
      parsed = JSON.parse(decodeBase64Utf8(json.content));
    } catch (e) {
      setSync("error", "data.json est illisible (JSON invalide) — restaure une version précédente depuis l'historique du dépôt de données.");
      throw new Error("badjson");
    }
    projects = parsed.projects || [];
    setSync("", "Connecté à GitHub — sauvegarde en direct");
    return true;
  }
  async function createInitialDataJson() {
    try {
      var content = encodeUtf8Base64(JSON.stringify({ projects: projects || [] }, null, 2));
      var res = await fetch(ghUrl("data.json"), {
        method: "PUT",
        headers: ghHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message: "Initialise data.json", content: content, branch: DATA_REPO_BRANCH })
      });
      if (!res.ok) return false;
      var json = await res.json();
      dataSha = json.content.sha;
      return true;
    } catch (e) { return false; }
  }
  async function saveDataJson(message) {
    setSync("syncing", "Enregistrement…");
    var content = encodeUtf8Base64(JSON.stringify({ projects: projects }, null, 2));
    var body = { message: message, content: content, branch: DATA_REPO_BRANCH };
    if (dataSha) body.sha = dataSha;
    var res = await fetch(ghUrl("data.json"), {
      method: "PUT",
      headers: ghHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (res.status === 409) {
      await loadDataJson();
      setSync("error", "Changements distants détectés et rechargés — réessaie ton action.");
      renderAll();
      throw new Error("conflict");
    }
    if (!res.ok) {
      var errBody = await res.json().catch(function () { return {}; });
      setSync("error", "Échec de la sauvegarde : " + (errBody.message || res.status));
      throw new Error("save-failed");
    }
    var json = await res.json();
    dataSha = json.content.sha;
    setSync("", "Connecté à GitHub — sauvegarde en direct");
  }
  function uploadDocFile(path, file, message) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = async function () {
        var b64 = reader.result.split(",")[1];
        try {
          var res = await fetch(ghUrl(path), {
            method: "PUT",
            headers: ghHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ message: message, content: b64, branch: DATA_REPO_BRANCH })
          });
          if (!res.ok) { reject(new Error("HTTP " + res.status)); return; }
          var json = await res.json();
          resolve(json.content.sha);
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error("lecture du fichier impossible")); };
      reader.readAsDataURL(file);
    });
  }
  async function deleteDocFile(path, sha, message) {
    var res = await fetch(ghUrl(path), {
      method: "DELETE",
      headers: ghHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message: message, sha: sha, branch: DATA_REPO_BRANCH })
    });
    return res.ok;
  }
  async function fetchDocBlob(path) {
    var res = await fetch(ghUrl(path), { headers: ghHeaders({ Accept: "application/vnd.github.raw" }) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.blob();
  }
  // ================================================================
  // Sync indicator
  // ================================================================
  function setSync(mode, label) {
    var dot = byId("syncDot");
    if (!dot) return;
    dot.className = "sync-dot" + (mode ? " " + mode : "");
    byId("syncLabel").textContent = label;
  }
  // ================================================================
  // Auth screens
  // ================================================================
  function showLogin(errorMsg) {
    byId("loginScreen").style.display = "flex";
    byId("root").style.display = "none";
    if (errorMsg) {
      byId("loginError").textContent = errorMsg;
      byId("loginError").style.display = "block";
    } else {
      byId("loginError").style.display = "none";
    }
  }
  function showApp() {
    byId("loginScreen").style.display = "none";
    byId("root").style.display = "block";
  }
  byId("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var token = byId("login-token").value.trim();
    if (!token) return;
    byId("loginSubmit").disabled = true;
    byId("loginSubmit").textContent = "Connexion…";
    setToken(token);
    try {
      var ok = await loadDataJson();
      if (ok) { showApp(); renderAll(); startPolling(); }
      else { showLogin("Connexion faite, mais data.json n'a pas pu être chargé ni créé — vérifie que le token a bien « Contents : Read and write » sur le dépôt de données, puis réessaie."); }
    } catch (err) {
      if (err && err.message === "auth") {
        clearToken();
        showLogin("Connexion refusée — vérifie le token et qu'il a bien accès (Contents : Read and write) au dépôt " + DATA_REPO_OWNER + "/" + DATA_REPO_NAME + ".");
      } else if (err && err.message === "badjson") {
        showLogin("Connexion réussie, mais data.json est illisible (JSON invalide) — restaure une version précédente depuis l'historique du dépôt de données, puis réessaie.");
      } else {
        showLogin("Impossible de joindre GitHub — vérifie ta connexion internet puis réessaie.");
      }
    }
    byId("loginSubmit").disabled = false;
    byId("loginSubmit").textContent = "Se connecter";
  });
  byId("logoutBtn").addEventListener("click", function () {
    clearToken();
    if (pollTimer) clearInterval(pollTimer);
    showLogin();
  });
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async function () {
      try {
        var res = await fetch(ghUrl("data.json"), { headers: ghHeaders() });
        if (res.ok) {
          var json = await res.json();
          if (json.sha !== dataSha) { await loadDataJson(); renderAll(); }
        }
      } catch (e) { /* ignore transient network errors */ }
    }, 45000);
  }
  // ================================================================
  // Filtering / sorting
  // ================================================================
  function matchesFilters(p) {
    if (state.category !== "all" && p.category !== state.category) return false;
    if (!state.priorities.has(p.priority)) return false;
    if (!state.statuses.has(p.status)) return false;
    if (state.search) {
      var q = state.search.toLowerCase();
      var inTitle = p.title.toLowerCase().indexOf(q) !== -1;
      var inNotes = (p.notes || "").toLowerCase().indexOf(q) !== -1;
      var inDocs = (p.documents || []).some(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
      if (!inTitle && !inNotes && !inDocs) return false;
    }
    return true;
  }
  function sortList(list) {
    var copy = list.slice();
    copy.sort(function (a, b) {
      if (state.sort === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.progress - a.progress;
      if (state.sort === "progress") return b.progress - a.progress;
      if (state.sort === "name") return a.title.localeCompare(b.title, "fr");
      if (state.sort === "date") return new Date(a.date || 0) - new Date(b.date || 0);
      return 0;
    });
    return copy;
  }
  function priorityIcon(prio) {
    if (prio === "haute") return "▲";
    if (prio === "moyenne") return "●";
    return "▽";
  }
  // ================================================================
  // Render: stats + chips
  // ================================================================
  function renderStats() {
    var visible = projects.filter(matchesFilters);
    var total = visible.length;
    var done = visible.filter(function (p) { return p.status === "fait"; }).length;
    var inProgress = visible.filter(function (p) { return p.status === "en_cours"; }).length;
    var blocked = visible.filter(function (p) { return p.status === "bloque"; }).length;
    var avg = total ? Math.round(visible.reduce(function (s, p) { return s + p.progress; }, 0) / total) : 0;
    var docCount = visible.reduce(function (s, p) { return s + (p.documents ? p.documents.length : 0); }, 0);
    var tiles = [
      { label: "Projets affichés", value: total, cls: "" },
      { label: "En cours", value: inProgress, cls: "warning" },
      { label: "Terminés", value: done, cls: "good" },
      { label: "Bloqués", value: blocked, cls: "critical" },
      { label: "Avancement moyen", value: avg + "%", cls: "" },
      { label: "Documents attachés", value: docCount, cls: "" }
    ];
    byId("stats").innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-value">' + t.value + '</div><div class="stat-label">' + t.label + '</div></div>';
    }).join("");
  }
  function renderChips() {
    byId("prioChips").innerHTML = Object.keys(PRIORITY_LABEL).map(function (k) {
      var active = state.priorities.has(k);
      return '<button class="chip' + (active ? " active" : "") + '" data-prio="' + k + '">' + PRIORITY_LABEL[k] + '</button>';
    }).join("");
    byId("statusChips").innerHTML = STATUS_ORDER.map(function (k) {
      var active = state.statuses.has(k);
      return '<button class="chip' + (active ? " active" : "") + '" data-status="' + k + '">' + STATUS_ICON[k] + ' ' + STATUS_LABEL[k] + '</button>';
    }).join("");
  }
  // ================================================================
  // Render: card / table / docs
  // ================================================================
  function cardHtml(p) {
    if (state.confirmDeleteId === p.id) {
      return '<div class="card"><div class="confirm-del">' +
        '<span>Supprimer « ' + esc(p.title) + ' » ?</span>' +
        '<span style="display:flex;gap:6px;">' +
        '<button class="btn small danger" data-action="delete-confirm" data-id="' + p.id + '">Confirmer</button>' +
        '<button class="btn small ghost" data-action="delete-cancel" data-id="' + p.id + '">Annuler</button>' +
        '</span></div></div>';
    }
    var docCount = (p.documents || []).length;
    return '' +
      '<div class="card">' +
        '<div class="card-top">' +
          '<div class="card-title-wrap"><div class="item-title">' + esc(p.title) + '</div></div>' +
          '<button class="card-icon-btn doc-badge" data-action="goto-docs" data-id="' + p.id + '" title="Documents">📎 ' + docCount + '</button>' +
          '<button class="card-icon-btn" data-action="edit" data-id="' + p.id + '" title="Modifier">✎</button>' +
          '<button class="card-icon-btn" data-action="delete" data-id="' + p.id + '" title="Supprimer">✕</button>' +
        '</div>' +
        '<div class="badges">' +
          '<span class="badge prio-' + p.priority + '">' + priorityIcon(p.priority) + ' ' + PRIORITY_LABEL[p.priority] + '</span>' +
          '<button class="status-pill ' + p.status + '" data-action="cycle-status" data-id="' + p.id + '" title="Cliquer pour changer le statut">' + STATUS_ICON[p.status] + ' ' + STATUS_LABEL[p.status] + '</button>' +
        '</div>' +
        '<div class="progress-row">' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + p.progress + '%;"></div></div>' +
          '<div class="progress-pct">' + p.progress + '%</div>' +
        '</div>' +
        (p.notes ? '<div class="item-notes">' + esc(p.notes) + '</div>' : '') +
        '<div class="item-meta"><span>' + CATEGORY_LABEL[p.category] + '</span><span>Ajouté le ' + esc(fmtDate(p.date)) + '</span></div>' +
      '</div>';
  }
  function tableHtml(list) {
    if (!list.length) return '<div class="empty">Aucun projet ne correspond aux filtres actuels.</div>';
    var rows = list.map(function (p) {
      return '<tr>' +
        '<td>' + CATEGORY_LABEL[p.category] + '</td>' +
        '<td>' + esc(p.title) + '</td>' +
        '<td>' + PRIORITY_LABEL[p.priority] + '</td>' +
        '<td>' + STATUS_ICON[p.status] + ' ' + STATUS_LABEL[p.status] + '</td>' +
        '<td>' + p.progress + '%</td>' +
        '<td>' + (p.documents ? p.documents.length : 0) + '</td>' +
        '<td>' + esc(fmtDate(p.date)) + '</td>' +
      '</tr>';
    }).join("");
    return '<table class="data-table"><thead><tr><th>Activité</th><th>Projet</th><th>Priorité</th><th>Statut</th><th>Avancement</th><th>Docs</th><th>Ajouté le</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function docRowHtml(d, pid) {
    var tag = d.kind === "livrable" ? '<span class="doc-tag livrable">★ Livrable</span>' : '<span class="doc-tag source">Source</span>';
    return '<div class="doc-row">' +
      '<span class="doc-icon">' + fileIcon(d.name) + '</span>' +
      '<div class="doc-name-wrap">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
          '<a class="doc-name" href="#" data-doc-download="' + esc(d.path) + '" data-doc-name="' + esc(d.name) + '">' + esc(d.name) + '</a>' + tag +
        '</div>' +
        '<div class="doc-meta-line">' + formatBytes(d.size) + ' · ajouté le ' + esc(fmtDate(d.date)) + '</div>' +
      '</div>' +
      '<div class="doc-actions">' +
        '<a class="card-icon-btn" href="#" data-doc-preview="' + esc(d.path) + '" title="Aperçu dans un nouvel onglet">👁️</a>' +
        '<button class="card-icon-btn" data-action="delete-doc" data-pid="' + pid + '" data-did="' + d.id + '" title="Supprimer le document">✕</button>' +
      '</div>' +
    '</div>';
  }
  function docSectionHtml(p) {
    var docs = p.documents || [];
    var sources = docs.filter(function (d) { return d.kind !== "livrable"; });
    var livrables = docs.filter(function (d) { return d.kind === "livrable"; });
    var activity = p.activity || [];
    var bodyHtml = '<div class="doc-group-label">Documents sources</div>';
    bodyHtml += sources.length ? '<div class="doc-list">' + sources.map(function (d) { return docRowHtml(d, p.id); }).join("") + '</div>' : '<div class="doc-empty">Aucun document source pour ce projet — dépose une analyse Excel, un PDF, des photos, une présentation…</div>';
    if (livrables.length) {
      bodyHtml += '<div class="doc-group-label" style="margin-top:10px;">★ Livrables produits</div>';
      bodyHtml += '<div class="doc-list">' + livrables.map(function (d) { return docRowHtml(d, p.id); }).join("") + '</div>';
    }
    bodyHtml += '<details class="doc-history"><summary>Historique' + (activity.length ? ' (' + activity.length + ')' : '') + '</summary>' +
      (activity.length ? activity.slice(0, 15).map(function (a) { return '<div class="activity-row"><span class="activity-date">' + esc(fmtDate(a.date)) + '</span><span>' + esc(a.text) + '</span></div>'; }).join("") : '<div class="doc-empty">Aucune activité pour le moment.</div>') +
    '</details>';
    return '<div class="doc-section" id="doc-section-' + p.id + '">' +
      '<div class="doc-section-head">' +
        '<div class="doc-section-title">' +
          '<span class="badge prio-' + p.priority + '">' + priorityIcon(p.priority) + ' ' + PRIORITY_LABEL[p.priority] + '</span>' +
          '<strong>' + esc(p.title) + '</strong>' +
          '<span class="section-sub">' + docs.length + ' document' + (docs.length > 1 ? "s" : "") + '</span>' +
        '</div>' +
        '<label class="btn small primary doc-upload-label">+ Ajouter un document' +
          '<input type="file" multiple class="doc-file-input" data-id="' + p.id + '">' +
        '</label>' +
      '</div>' +
      bodyHtml +
    '</div>';
  }
  function renderDocsView() {
    var visible = projects.filter(matchesFilters);
    var content = byId("content");
    var cats = state.category === "all" ? ["althea", "bsm"] : [state.category];
    var html = "";
    if (state.docWarning) {
      html += '<div class="doc-warning"><span>⚠️ ' + esc(state.docWarning) + '</span><button class="card-icon-btn" data-action="dismiss-doc-warning" title="Fermer">✕</button></div>';
    }
    cats.forEach(function (cat) {
      var list = sortList(visible.filter(function (p) { return p.category === cat; }));
      html += '<div class="section">' +
        '<div class="section-head">' +
          '<span class="dot ' + cat + '"></span>' +
          '<h2 class="section-title">' + CATEGORY_LABEL[cat] + (cat === "althea" ? ' <span class="section-sub">(activité pro)</span>' : ' <span class="section-sub">(entreprise en développement)</span>') + '</h2>' +
          '<span class="section-count">' + list.length + '</span>' +
        '</div>';
      html += list.length ? list.map(docSectionHtml).join("") : '<div class="empty">Aucun projet ' + CATEGORY_LABEL[cat] + ' pour le moment.</div>';
      html += '</div>';
    });
    content.innerHTML = html;
  }
  function renderContent() {
    if (state.view === "table") { byId("content").innerHTML = tableHtml(sortList(projects.filter(matchesFilters))); return; }
    if (state.view === "docs") { renderDocsView(); return; }
    var visible = projects.filter(matchesFilters);
    var content = byId("content");
    var cats = state.category === "all" ? ["althea", "bsm"] : [state.category];
    var html = "";
    cats.forEach(function (cat) {
      var list = sortList(visible.filter(function (p) { return p.category === cat; }));
      html += '<div class="section">' +
        '<div class="section-head">' +
          '<span class="dot ' + cat + '"></span>' +
          '<h2 class="section-title">' + CATEGORY_LABEL[cat] + (cat === 'althea' ? ' <span class="section-sub">(activité pro)</span>' : ' <span class="section-sub">(entreprise en développement)</span>') + '</h2>' +
          '<span class="section-count">' + list.length + '</span>' +
        '</div>' +
        '<div class="cards-grid">' +
          (list.length ? list.map(cardHtml).join("") : '<div class="empty">Aucun projet ' + CATEGORY_LABEL[cat] + ' pour le moment. Clique sur « + Nouveau projet » pour en ajouter un.</div>') +
        '</div>' +
      '</div>';
    });
    content.innerHTML = html;
  }
  function renderAll() {
    renderStats();
    renderChips();
    renderContent();
    byId("catSeg").querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-cat") === state.category); });
    byId("viewSeg").querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === state.view); });
    byId("updated").textContent = "Dernière synchronisation : " + new Date().toLocaleString("fr-FR");
  }
  // ================================================================
  // Modal / form (create + edit)
  // ================================================================
  function openModal(id) {
    state.editingId = id || null;
    var p = id ? projects.find(function (x) { return x.id === id; }) : null;
    byId("modalTitle").textContent = p ? "Modifier le projet" : "Nouveau projet";
    byId("f-title").value = p ? p.title : "";
    byId("f-category").value = p ? p.category : (state.category !== "all" ? state.category : "bsm");
    byId("f-priority").value = p ? p.priority : "moyenne";
    byId("f-status").value = p ? p.status : "a_faire";
    byId("f-progress").value = p ? p.progress : 0;
    byId("f-progress-val").textContent = (p ? p.progress : 0) + "%";
    byId("f-notes").value = p ? p.notes : "";
    byId("modalBackdrop").style.display = "flex";
    byId("f-title").focus();
  }
  function closeModal() {
    byId("modalBackdrop").style.display = "none";
    state.editingId = null;
  }
  async function saveForm(e) {
    e.preventDefault();
    var title = byId("f-title").value.trim();
    if (!title) return;
    var data = {
      title: title,
      category: byId("f-category").value,
      priority: byId("f-priority").value,
      status: byId("f-status").value,
      progress: parseInt(byId("f-progress").value, 10) || 0,
      notes: byId("f-notes").value.trim()
    };
    byId("modalSave").disabled = true;
    try {
      if (state.editingId) {
        var p = projects.find(function (x) { return x.id === state.editingId; });
        var changes = [];
        if (p.status !== data.status) changes.push("Statut : " + STATUS_LABEL[p.status] + " → " + STATUS_LABEL[data.status]);
        if (p.progress !== data.progress) changes.push("Avancement : " + p.progress + "% → " + data.progress + "%");
        if (p.priority !== data.priority) changes.push("Priorité : " + PRIORITY_LABEL[p.priority] + " → " + PRIORITY_LABEL[data.priority]);
        Object.assign(p, data);
        logActivity(p, changes.length ? changes.join(" · ") : "Fiche projet modifiée");
        await saveDataJson("Modifie projet : " + p.title);
      } else {
        data.id = uid();
        data.date = new Date().toISOString();
        data.documents = [];
        data.activity = [];
        logActivity(data, "Projet créé");
        projects.push(data);
        await saveDataJson("Crée projet : " + data.title);
      }
      closeModal();
      renderAll();
    } catch (err) { /* erreur déjà affichée via le bandeau de sync */ }
    byId("modalSave").disabled = false;
  }
  // ================================================================
  // Document upload / delete / open
  // ================================================================
  async function handleDocUpload(pid, fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var warnings = [];
    var p = projects.find(function (x) { return x.id === pid; });
    if (!p) return;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.size > MAX_FILE_BYTES) { warnings.push(file.name + " dépasse 20 Mo et a été ignoré."); continue; }
      var path = "documents/" + pid + "/" + Date.now() + "-" + uid() + "-" + safeName(file.name);
      try {
        var sha = await uploadDocFile(path, file, "Ajoute document : " + file.name);
        if (!p.documents) p.documents = [];
        p.documents.push({ id: uid(), name: file.name, size: file.size, mime: file.type, path: path, sha: sha, kind: "source", date: new Date().toISOString() });
        logActivity(p, "Document ajouté : " + file.name);
      } catch (err) {
        warnings.push(file.name + " : échec de l'envoi.");
      }
    }
    state.docWarning = warnings.join(" ");
    try { await saveDataJson("Ajoute documents à " + p.title); } catch (e) { /* déjà signalé */ }
    renderAll();
    if (state.view === "docs") {
      var el = byId("doc-section-" + pid);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
  async function handleDocOpen(path, name, preview) {
    try {
      var blob = await fetchDocBlob(path);
      var url = URL.createObjectURL(blob);
      if (preview) {
        window.open(url, "_blank", "noopener");
      } else {
        var a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (err) {
      alert("Impossible d'ouvrir ce document : " + err.message);
    }
  }
  // ================================================================
  // Events
  // ================================================================
  document.addEventListener("click", async function (e) {
    var dl = e.target.closest("[data-doc-download]");
    if (dl) { e.preventDefault(); handleDocOpen(dl.getAttribute("data-doc-download"), dl.getAttribute("data-doc-name"), false); return; }
    var pv = e.target.closest("[data-doc-preview]");
    if (pv) { e.preventDefault(); handleDocOpen(pv.getAttribute("data-doc-preview"), "", true); return; }
    var t = e.target.closest("[data-action]");
    if (t) {
      var id = t.getAttribute("data-id");
      var action = t.getAttribute("data-action");
      if (action === "edit") openModal(id);
      if (action === "delete") { state.confirmDeleteId = id; renderContent(); }
      if (action === "delete-cancel") { state.confirmDeleteId = null; renderContent(); }
      if (action === "delete-confirm") {
        var proj = projects.find(function (x) { return x.id === id; });
        if (proj) {
          for (var i = 0; i < (proj.documents || []).length; i++) {
            var d = proj.documents[i];
            try { await deleteDocFile(d.path, d.sha, "Supprime document (projet supprimé) : " + d.name); } catch (e) { /* ignore */ }
          }
        }
        projects = projects.filter(function (x) { return x.id !== id; });
        state.confirmDeleteId = null;
        try { await saveDataJson("Supprime projet : " + (proj ? proj.title : id)); } catch (e) { /* déjà signalé */ }
        renderAll();
      }
      if (action === "cycle-status") {
        var p = projects.find(function (x) { return x.id === id; });
        var oldStatus = p.status;
        var idx = STATUS_ORDER.indexOf(p.status);
        var newStatus = STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
        var newProgress = p.progress;
        if (newStatus === "fait") newProgress = 100;
        if (newStatus === "a_faire") newProgress = Math.min(p.progress, 10);
        p.status = newStatus; p.progress = newProgress;
        logActivity(p, "Statut : " + STATUS_LABEL[oldStatus] + " → " + STATUS_LABEL[newStatus] + " (" + newProgress + "%)");
        try { await saveDataJson("Statut " + p.title + " → " + newStatus); } catch (e) { /* déjà signalé */ }
        renderAll();
      }
      if (action === "goto-docs") {
        state.view = "docs";
        renderAll();
        var target = byId("doc-section-" + id);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (action === "delete-doc") {
        var pid = t.getAttribute("data-pid");
        var did = t.getAttribute("data-did");
        var pr = projects.find(function (x) { return x.id === pid; });
        var doc = pr ? (pr.documents || []).find(function (x) { return x.id === did; }) : null;
        if (doc) {
          try { await deleteDocFile(doc.path, doc.sha, "Supprime document : " + doc.name); } catch (e) { /* ignore */ }
          pr.documents = pr.documents.filter(function (x) { return x.id !== did; });
          logActivity(pr, "Document supprimé : " + doc.name);
          try { await saveDataJson("Supprime document de " + pr.title); } catch (e) { /* déjà signalé */ }
        }
        renderAll();
      }
      if (action === "dismiss-doc-warning") { state.docWarning = ""; renderContent(); }
      return;
    }
    if (e.target.closest("#addBtn")) openModal(null);
    if (e.target.closest("#modalCancel") || e.target === byId("modalBackdrop")) closeModal();
    var prioChip = e.target.closest("[data-prio]");
    if (prioChip) {
      var pk = prioChip.getAttribute("data-prio");
      if (state.priorities.has(pk)) state.priorities.delete(pk); else state.priorities.add(pk);
      renderAll();
    }
    var statusChip = e.target.closest("[data-status]");
    if (statusChip) {
      var sk = statusChip.getAttribute("data-status");
      if (state.statuses.has(sk)) state.statuses.delete(sk); else state.statuses.add(sk);
      renderAll();
    }
    var catBtn = e.target.closest("#catSeg button");
    if (catBtn) { state.category = catBtn.getAttribute("data-cat"); renderAll(); }
    var viewBtn = e.target.closest("#viewSeg button");
    if (viewBtn) { state.view = viewBtn.getAttribute("data-view"); renderAll(); }
  });
  document.addEventListener("change", function (e) {
    var input = e.target.closest(".doc-file-input");
    if (input) {
      state.docWarning = "";
      handleDocUpload(input.getAttribute("data-id"), input.files);
      input.value = "";
    }
  });
  byId("projectForm").addEventListener("submit", saveForm);
  byId("f-progress").addEventListener("input", function () { byId("f-progress-val").textContent = this.value + "%"; });
  byId("searchInput").addEventListener("input", function () { state.search = this.value; renderContent(); renderStats(); });
  byId("sortSelect").addEventListener("change", function () { state.sort = this.value; renderContent(); });
  byId("themeToggle").addEventListener("click", function () {
    var html = document.documentElement;
    var current = html.getAttribute("data-theme");
    if (current === "dark") html.setAttribute("data-theme", "light");
    else if (current === "light") html.removeAttribute("data-theme");
    else html.setAttribute("data-theme", "dark");
  });
  byId("exportBtn").addEventListener("click", function () {
    var payload = { exportedAt: new Date().toISOString(), projects: projects };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "althea-bsm-dashboard-export.json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  // ================================================================
  // Boot
  // ================================================================
  async function boot() {
    var token = getToken();
    if (!token) { showLogin(); return; }
    try {
      var ok = await loadDataJson();
      if (ok) { showApp(); renderAll(); startPolling(); }
      else { showLogin(); }
    } catch (err) {
      if (err && err.message === "auth") {
        clearToken();
        showLogin("Session invalide, reconnecte-toi avec un token valide.");
      } else if (err && err.message === "badjson") {
        showLogin("data.json est illisible (JSON invalide) — restaure une version précédente depuis l'historique du dépôt de données, puis recharge cette page.");
      } else {
        showLogin("Impossible de joindre GitHub pour le moment (réseau ?). Ton token est conservé — recharge la page pour réessayer.");
      }
    }
  }
  boot();
})();
