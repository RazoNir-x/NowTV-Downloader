// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const fromEp = document.getElementById('fromEp');
const toEp = document.getElementById('toEp');
const downloadBtn = document.getElementById('downloadBtn');
const batchSection = document.getElementById('batchSection');
const batchShowName = document.getElementById('batchShowName');
const batchCount = document.getElementById('batchCount');
const batchFill = document.getElementById('batchFill');
const episodeQueue = document.getElementById('episodeQueue');
const consoleBody = document.getElementById('consoleBody');
const completeBanner = document.getElementById('completeBanner');
const completeTitle = document.getElementById('completeTitle');
const completeDetails = document.getElementById('completeDetails');
const libraryPage = document.getElementById('libraryPage');
const downloadPage = document.getElementById('downloadPage');
const libraryContent = document.getElementById('libraryContent');
const librarySubtitle = document.getElementById('librarySubtitle');
const libraryBadge = document.getElementById('libraryBadge');
const sidebarShows = document.getElementById('sidebarShows');
const timingElapsed = document.getElementById('timingElapsed');
const timingEta = document.getElementById('timingEta');
const timingAvg = document.getElementById('timingAvg');

let eventSource = null;
let elapsedTimer = null;

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadLibrary();
  urlInput.addEventListener('input', () => {
    const url = urlInput.value.trim();
    const match = url.match(/\/bolum\/(\d+)/) || url.match(/-bolum-(\d+)/);
    if (match) {
      const ep = parseInt(match[1]);
      fromEp.value = ep;
      if (parseInt(toEp.value) < ep) toEp.value = ep;
    }
  });
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') startBatchDownload(); });
});

// ─────────────────────────────────────────────
// PAGE SWITCHING
// ─────────────────────────────────────────────
function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');
  if (page === 'download') {
    downloadPage.classList.remove('hidden');
    libraryPage.classList.remove('active');
  } else {
    downloadPage.classList.add('hidden');
    libraryPage.classList.add('active');
    loadLibrary();
  }
}

// ─────────────────────────────────────────────
// BATCH DOWNLOAD
// ─────────────────────────────────────────────
async function startBatchDownload() {
  const url = urlInput.value.trim();
  if (!url || (!url.includes('nowtv.com.tr') && !url.includes('showtv.com.tr'))) { 
    shake(urlInput); 
    return; 
  }
  const from = parseInt(fromEp.value) || 1;
  const to = parseInt(toEp.value) || from;
  if (to < from) { shake(toEp); return; }

  resetBatch();
  downloadBtn.classList.add('loading');
  downloadBtn.disabled = true;
  batchSection.style.display = 'block';

  const batchStartClient = Date.now();
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const ms = Date.now() - batchStartClient;
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
    timingElapsed.textContent = h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  try {
    const resp = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, fromEpisode: from, toEpisode: to })
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
    const { sessionId, showName, episodes } = await resp.json();
    batchShowName.textContent = `📥 ${showName}`;
    buildQueue(episodes);
    connectBatchSSE(sessionId);
  } catch (err) {
    addLog(`❌ ${err.message}`, 'error');
    downloadBtn.classList.remove('loading');
    downloadBtn.disabled = false;
  }
}

function buildQueue(episodes) {
  episodeQueue.innerHTML = '';
  for (const ep of episodes) {
    const div = document.createElement('div');
    div.className = `queue-item ${ep.status}`;
    div.id = `queue-ep-${ep.episode}`;
    div.innerHTML = `
      <div class="queue-ep">${ep.episode}</div>
      <div class="queue-info">
        <div class="queue-info-name">פרק ${ep.episode}</div>
        <div class="queue-info-status" id="queue-status-${ep.episode}">${statusLabel(ep.status)}</div>
      </div>
      <div class="queue-progress"><div class="queue-progress-bar" id="queue-bar-${ep.episode}"></div></div>
      <div class="queue-time" id="queue-time-${ep.episode}"></div>
      <div class="queue-status-icon" id="queue-icon-${ep.episode}">${statusIcon(ep.status)}</div>
    `;
    episodeQueue.appendChild(div);
  }
}

function statusLabel(s) {
  return { pending:'ממתין...', downloading:'מוריד...', complete:'הושלם ✓', exists:'כבר קיים', error:'שגיאה' }[s] || s;
}
function statusIcon(s) {
  return { pending:'⏳', downloading:'📥', complete:'✅', exists:'⏭️', error:'❌' }[s] || '•';
}

function connectBatchSSE(sessionId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/batch/progress/${sessionId}`);

  eventSource.addEventListener('init', e => {
    const d = JSON.parse(e.data);
    batchShowName.textContent = `📥 ${d.showName}`;
  });
  eventSource.addEventListener('episode_status', e => {
    const { episode, status } = JSON.parse(e.data);
    const item = document.getElementById(`queue-ep-${episode}`);
    if (item) item.className = `queue-item ${status}`;
    const st = document.getElementById(`queue-status-${episode}`);
    if (st) st.textContent = statusLabel(status);
    const ic = document.getElementById(`queue-icon-${episode}`);
    if (ic) ic.textContent = statusIcon(status);
  });
  eventSource.addEventListener('episode_progress', e => {
    const { episode, percent } = JSON.parse(e.data);
    const bar = document.getElementById(`queue-bar-${episode}`);
    if (bar) bar.style.width = `${Math.min(percent, 100)}%`;
    const st = document.getElementById(`queue-status-${episode}`);
    if (st) st.textContent = `מוריד... ${percent.toFixed(1)}%`;
  });
  eventSource.addEventListener('batch_progress', e => {
    const { downloaded, total, skipped } = JSON.parse(e.data);
    const done = downloaded + skipped, all = total + skipped;
    batchCount.textContent = `${done} / ${all}`;
    batchFill.style.width = `${(done / all) * 100}%`;
  });
  eventSource.addEventListener('timing', e => {
    const { eta, avgPerEp } = JSON.parse(e.data);
    timingEta.textContent = eta;
    timingAvg.textContent = avgPerEp;
  });
  eventSource.addEventListener('episode_time', e => {
    const { episode, duration } = JSON.parse(e.data);
    const t = document.getElementById(`queue-time-${episode}`);
    if (t) t.textContent = duration;
  });
  eventSource.addEventListener('log', e => {
    const { message } = JSON.parse(e.data);
    addLog(message, message.includes('✅') ? 'success' : message.includes('❌') ? 'error' : '');
  });
  eventSource.addEventListener('ytdlp', e => addLog(JSON.parse(e.data).message));
  eventSource.addEventListener('batch_complete', e => {
    const d = JSON.parse(e.data);
    completeBanner.classList.add('active');
    completeTitle.textContent = `🎉 ${d.showName} — הורדה הושלמה!`;
    const p = [];
    if (d.downloaded > 0) p.push(`${d.downloaded} פרקים`);
    if (d.skipped > 0) p.push(`${d.skipped} קיימים`);
    if (d.errors > 0) p.push(`${d.errors} שגיאות`);
    if (d.totalTime) p.push(`סה"כ ${d.totalTime}`);
    if (d.avgPerEp) p.push(`ממוצע ${d.avgPerEp}/פרק`);
    completeDetails.textContent = p.join(' • ');
    batchCount.textContent = 'הושלם!';
    batchFill.style.width = '100%';
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    downloadBtn.classList.remove('loading'); downloadBtn.disabled = false;
    eventSource.close(); loadLibrary();
  });
  eventSource.onerror = () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      downloadBtn.classList.remove('loading'); downloadBtn.disabled = false;
    }
  };
}

// ─────────────────────────────────────────────
// LIBRARY
// ─────────────────────────────────────────────
async function loadLibrary() {
  try {
    const resp = await fetch('/api/library');
    const library = await resp.json();

    // Sidebar
    sidebarShows.innerHTML = '';
    for (const show of library) {
      const div = document.createElement('div');
      div.className = 'library-show';
      div.innerHTML = `
        <div class="library-show-name">${show.showName}</div>
        <div class="library-show-meta">${show.episodeCount} פרקים • ${show.totalSize}</div>
      `;
      div.onclick = () => switchPage('library');
      sidebarShows.appendChild(div);
    }

    // Badge
    if (library.length > 0) {
      libraryBadge.style.display = 'inline';
      libraryBadge.textContent = library.length;
    }

    // Library page
    const totalEps = library.reduce((s, sh) => s + sh.episodeCount, 0);
    librarySubtitle.textContent = `${library.length} סדרות • ${totalEps} פרקים`;
    libraryContent.innerHTML = '';

    for (const show of library) {
      const card = document.createElement('div');
      card.className = 'show-card';

      // Subtitle status
      const hasTxt = show.subtitlesTxt > 0;
      const hasVtt = show.subtitlesVtt > 0;
      let subInfo = '';
      if (hasTxt && !hasVtt) subInfo = `<span class="sub-badge sub-txt">📝 ${show.subtitlesTxt} כתוביות טורקיות</span>`;
      else if (hasTxt && hasVtt) subInfo = `<span class="sub-badge sub-vtt">✅ ${show.subtitlesVtt} תורגמו</span><span class="sub-badge sub-txt">${show.subtitlesTxt - show.subtitlesVtt > 0 ? `📝 ${show.subtitlesTxt - show.subtitlesVtt} לתרגום` : ''}</span>`;
      else if (hasVtt) subInfo = `<span class="sub-badge sub-vtt">✅ ${show.subtitlesVtt} תורגמו</span>`;

      // Seasons HTML
      let seasonsHtml = '';
      for (const season of show.seasons) {
        const seasonTitle = season.name || 'כללי';
        const subStat = season.subtitlesTxt > 0
          ? `<span class="season-sub">${season.subtitlesVtt}/${season.subtitlesTxt} תורגמו</span>` : '';
        seasonsHtml += `
          <div class="season-block">
            ${show.seasons.length > 1 ? `<div class="season-title">${seasonTitle} <span class="season-meta">${season.episodeCount} פרקים • ${season.totalSize} ${subStat}</span></div>` : ''}
            <div class="show-episodes-grid">
              ${season.episodes.map(ep => `<div class="ep-chip" title="${ep.name} (${ep.size})">${ep.name.replace(/\.[^.]+$/, '')}</div>`).join('')}
            </div>
          </div>`;
      }

      card.innerHTML = `
        <div class="show-card-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="show-card-icon">🎬</div>
          <div class="show-card-info">
            <div class="show-card-title">${show.showName}</div>
            <div class="show-card-meta">${show.episodeCount} פרקים • ${show.totalSize}</div>
            <div class="show-card-subs">${subInfo}</div>
          </div>
          <div class="show-card-actions">
            ${hasTxt ? `<button class="btn-translate" onclick="event.stopPropagation(); startTranslation('${show.showName.replace(/'/g, "\\'")}')">🌐 תרגם כתוביות</button>` : ''}
            <button class="btn-fix-encoding" onclick="event.stopPropagation(); startFixEncoding('${show.showName.replace(/'/g, "\\'")}')">🔧 תיקון קידוד</button>
          </div>
        </div>
        <div class="show-card-body">
          ${seasonsHtml}
        </div>
      `;
      libraryContent.appendChild(card);
    }
  } catch (e) {
    librarySubtitle.textContent = 'שגיאה בטעינה';
  }
}

// ─────────────────────────────────────────────
// TRANSLATION
// ─────────────────────────────────────────────
async function startTranslation(showName) {
  // Switch to library page and show translation modal
  switchPage('library');

  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showName })
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
    const data = await resp.json();

    if (data.toTranslate === 0) {
      alert(`${showName}: כל הכתוביות כבר תורגמו! (${data.alreadyTranslated} קבצים)`);
      return;
    }

    // Create translation modal
    showTranslationUI(data.sessionId, showName, data);
  } catch (err) {
    alert(`שגיאה: ${err.message}`);
  }
}

function showTranslationUI(sessionId, showName, data) {
  // Remove existing modal if any
  const existing = document.getElementById('translateModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'translateModal';
  modal.className = 'translate-modal';
  modal.innerHTML = `
    <div class="translate-overlay" onclick="closeTranslateModal()"></div>
    <div class="translate-panel">
      <div class="translate-header">
        <div>
          <h3>🌐 תרגום כתוביות — ${showName}</h3>
          <p class="translate-meta">${data.totalFiles} קבצים • ${data.toTranslate} לתרגום • ${data.alreadyTranslated} כבר תורגמו</p>
        </div>
        <button class="translate-close" onclick="closeTranslateModal()">✕</button>
      </div>
      <div class="translate-progress-bar">
        <div class="translate-progress-fill" id="tProgressFill"></div>
      </div>
      <div class="translate-stats">
        <div class="translate-stat">
          <span class="translate-stat-label">קבצים</span>
          <span class="translate-stat-value" id="tFileCount">0 / ${data.toTranslate}</span>
        </div>
        <div class="translate-stat">
          <span class="translate-stat-label">שורות</span>
          <span class="translate-stat-value" id="tLineCount">—</span>
        </div>
        <div class="translate-stat">
          <span class="translate-stat-label">זמן</span>
          <span class="translate-stat-value" id="tElapsed">0:00</span>
        </div>
      </div>
      <div class="translate-files" id="tFileList">
        ${data.files.map(f => `
          <div class="translate-file ${f.alreadyTranslated ? 'done' : ''}" id="tfile-${CSS.escape(f.relativePath)}">
            <span class="translate-file-icon">${f.alreadyTranslated ? '✅' : '📝'}</span>
            <span class="translate-file-name">${f.relativePath}</span>
            <span class="translate-file-status">${f.alreadyTranslated ? 'תורגם' : 'ממתין'}</span>
          </div>
        `).join('')}
      </div>
      <div class="translate-console">
        <div class="console-header">
          <div class="console-dots"><span class="console-dot"></span><span class="console-dot"></span><span class="console-dot"></span></div>
          <span>TRANSLATION LOG</span>
        </div>
        <div class="console-body" id="tConsole"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('active'));

  // Connect SSE
  connectTranslateSSE(sessionId, data);
}

function closeTranslateModal() {
  const modal = document.getElementById('translateModal');
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => modal.remove(), 300);
  }
  loadLibrary();
}

function connectTranslateSSE(sessionId, data) {
  const es = new EventSource(`/api/translate/progress/${sessionId}`);
  const tConsole = document.getElementById('tConsole');
  const tProgressFill = document.getElementById('tProgressFill');
  const tFileCount = document.getElementById('tFileCount');
  const tLineCount = document.getElementById('tLineCount');
  const tElapsed = document.getElementById('tElapsed');

  // Live timer
  const tStart = Date.now();
  const tTimer = setInterval(() => {
    const s = Math.floor((Date.now() - tStart) / 1000);
    const m = Math.floor(s / 60);
    tElapsed.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  es.addEventListener('log', e => {
    const { message } = JSON.parse(e.data);
    const line = document.createElement('div');
    line.className = `log-line ${message.includes('✅') ? 'success' : message.includes('❌') ? 'error' : ''}`;
    line.textContent = message;
    tConsole.appendChild(line);
    while (tConsole.children.length > 200) tConsole.removeChild(tConsole.firstChild);
    tConsole.scrollTop = tConsole.scrollHeight;
  });

  es.addEventListener('file_status', e => {
    const { file, status } = JSON.parse(e.data);
    const el = document.getElementById(`tfile-${CSS.escape(file)}`);
    if (el) {
      el.className = `translate-file ${status === 'complete' ? 'done' : status === 'translating' ? 'active' : status === 'error' ? 'err' : status === 'exists' ? 'done' : ''}`;
      const ico = el.querySelector('.translate-file-icon');
      const st = el.querySelector('.translate-file-status');
      if (status === 'translating') { ico.textContent = '🔄'; st.textContent = 'מתרגם...'; }
      else if (status === 'complete') { ico.textContent = '✅'; st.textContent = 'הושלם'; }
      else if (status === 'error') { ico.textContent = '❌'; st.textContent = 'שגיאה'; }
      else if (status === 'exists') { ico.textContent = '⏭️'; st.textContent = 'קיים'; }
    }
  });

  es.addEventListener('translate_progress', e => {
    const { current, total } = JSON.parse(e.data);
    tLineCount.textContent = `${current} / ${total}`;
  });

  es.addEventListener('translate_batch_progress', e => {
    const { translated, total } = JSON.parse(e.data);
    tFileCount.textContent = `${translated} / ${total}`;
    tProgressFill.style.width = `${(translated / total) * 100}%`;
  });

  es.addEventListener('translate_complete', e => {
    const d = JSON.parse(e.data);
    clearInterval(tTimer);
    tProgressFill.style.width = '100%';
    tFileCount.textContent = `${d.translated} / ${d.total} ✓`;
    const header = document.querySelector('.translate-header h3');
    if (header) header.textContent = `✅ תרגום הושלם — ${d.showName}`;
    es.close();
    loadLibrary();
  });

  es.onerror = () => { if (es.readyState === EventSource.CLOSED) clearInterval(tTimer); };
}

// ─────────────────────────────────────────────
// FIX ENCODING
// ─────────────────────────────────────────────
async function startFixEncoding(showName) {
  switchPage('library');

  try {
    const resp = await fetch('/api/fix-encoding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showName })
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
    const data = await resp.json();

    if (data.totalFiles === 0) {
      alert(`${showName}: לא נמצאו קבצי וידאו לסידור ותיקון.`);
      return;
    }

    showFixEncodingUI(data.sessionId, showName, data);
  } catch (err) {
    alert(`שגיאה: ${err.message}`);
  }
}

function showFixEncodingUI(sessionId, showName, data) {
  const existing = document.getElementById('fixModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'fixModal';
  modal.className = 'translate-modal';
  modal.innerHTML = `
    <div class="translate-overlay" onclick="closeFixModal()"></div>
    <div class="translate-panel">
      <div class="translate-header">
        <div>
          <h3>🔧 תיקון קידוד וסידור שמות — ${showName}</h3>
          <p class="translate-meta">${data.totalFiles} קבצי וידאו לעיבוד (FFmpeg copy + התאמת תרגומים)</p>
        </div>
        <button class="translate-close" onclick="closeFixModal()">✕</button>
      </div>
      <div class="translate-progress-bar">
        <div class="translate-progress-fill" id="fProgressFill"></div>
      </div>
      <div class="translate-stats">
        <div class="translate-stat">
          <span class="translate-stat-label">קבצים</span>
          <span class="translate-stat-value" id="fFileCount">0 / ${data.totalFiles}</span>
        </div>
        <div class="translate-stat">
          <span class="translate-stat-label">זמן</span>
          <span class="translate-stat-value" id="fElapsed">0:00</span>
        </div>
      </div>
      <div class="translate-files" id="fFileList">
        ${data.files.map(f => `
          <div class="translate-file" id="ffile-${CSS.escape(f.relativePath)}">
            <span class="translate-file-icon">🎬</span>
            <span class="translate-file-name">${f.relativePath} ➔ ${f.targetName}</span>
            <span class="translate-file-status">ממתין</span>
          </div>
        `).join('')}
      </div>
      <div class="translate-console">
        <div class="console-header">
          <div class="console-dots"><span class="console-dot"></span><span class="console-dot"></span><span class="console-dot"></span></div>
          <span>ENCODING FIX LOG</span>
        </div>
        <div class="console-body" id="fConsole"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('active'));

  connectFixEncodingSSE(sessionId, data);
}

function closeFixModal() {
  const modal = document.getElementById('fixModal');
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => modal.remove(), 300);
  }
  loadLibrary();
}

function connectFixEncodingSSE(sessionId, data) {
  const es = new EventSource(`/api/fix-encoding/progress/${sessionId}`);
  const fConsole = document.getElementById('fConsole');
  const fProgressFill = document.getElementById('fProgressFill');
  const fFileCount = document.getElementById('fFileCount');
  const fElapsed = document.getElementById('fElapsed');

  const fStart = Date.now();
  const fTimer = setInterval(() => {
    const s = Math.floor((Date.now() - fStart) / 1000);
    const m = Math.floor(s / 60);
    fElapsed.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  es.addEventListener('log', e => {
    const { message } = JSON.parse(e.data);
    const line = document.createElement('div');
    line.className = `log-line ${message.includes('✅') ? 'success' : message.includes('❌') ? 'error' : ''}`;
    line.textContent = message;
    fConsole.appendChild(line);
    while (fConsole.children.length > 200) fConsole.removeChild(fConsole.firstChild);
    fConsole.scrollTop = fConsole.scrollHeight;
  });

  es.addEventListener('file_status', e => {
    const { file, status } = JSON.parse(e.data);
    const el = document.getElementById(`ffile-${CSS.escape(file)}`);
    if (el) {
      el.className = `translate-file ${status === 'complete' ? 'done' : status === 'processing' ? 'active' : status === 'error' ? 'err' : ''}`;
      const ico = el.querySelector('.translate-file-icon');
      const st = el.querySelector('.translate-file-status');
      if (status === 'processing') { ico.textContent = '🔄'; st.textContent = 'מעבד...'; }
      else if (status === 'complete') { ico.textContent = '✅'; st.textContent = 'תוקן'; }
      else if (status === 'error') { ico.textContent = '❌'; st.textContent = 'שגיאה'; }
    }
  });

  es.addEventListener('fix_batch_progress', e => {
    const { completed, total } = JSON.parse(e.data);
    fFileCount.textContent = `${completed} / ${total}`;
    fProgressFill.style.width = `${(completed / total) * 100}%`;
  });

  es.addEventListener('fix_complete', e => {
    const d = JSON.parse(e.data);
    clearInterval(fTimer);
    fProgressFill.style.width = '100%';
    fFileCount.textContent = `${d.completed} / ${d.total} ✓`;
    const header = document.querySelector('#fixModal .translate-header h3');
    if (header) header.textContent = `✅ תיקון הקידוד הושלם — ${d.showName}`;
    es.close();
    loadLibrary();
  });

  es.onerror = () => { if (es.readyState === EventSource.CLOSED) clearInterval(fTimer); };
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function addLog(msg, type = '') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = msg;
  consoleBody.appendChild(line);
  while (consoleBody.children.length > 200) consoleBody.removeChild(consoleBody.firstChild);
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

function resetBatch() {
  episodeQueue.innerHTML = '';
  consoleBody.innerHTML = '';
  completeBanner.classList.remove('active');
  batchFill.style.width = '0%';
  batchCount.textContent = '0 / 0';
  timingElapsed.textContent = '0:00';
  timingEta.textContent = '--:--';
  timingAvg.textContent = '--:--';
}

function shake(el) {
  el.style.animation = 'none'; el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  setTimeout(() => el.style.animation = '', 400);
}

const style = document.createElement('style');
style.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}`;
document.head.appendChild(style);
