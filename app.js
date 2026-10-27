/* ===== Camera App - Main Logic ===== */

const DB_NAME = 'CameraAppDB';
const DB_VERSION = 1;
const STORE_NAME = 'media';

let db = null;
let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let currentMode = 'photo';
let facingMode = 'environment';
let flashOn = false;
let track = null;
let mediaItems = [];
let currentPreviewId = null;
let timerInterval = null;
let seconds = 0;

// DOM refs
const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const canvas = $('#canvas');
const permissionScreen = $('#permission-screen');
const cameraView = $('#camera-view');
const galleryView = $('#gallery-view');
const previewModal = $('#preview-modal');
const timerEl = $('#timer');
const shutterBtn = $('#shutter-btn');
const flashBtn = $('#flash-btn');
const switchBtn = $('#switch-btn');
const galleryBtn = $('#gallery-btn');
const galleryThumb = $('#gallery-thumb');
const zoomSlider = $('#zoom');
const zoomValue = $('#zoom-value');
const galleryGrid = $('#gallery-grid');
const itemCount = $('#item-count');

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function saveItem(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteItemFromDB(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function loadAllItems() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function clearAllFromDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ===== Toast =====
function showToast(msg, duration = 2200) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ===== Camera =====
async function startCamera() {
  try {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
      audio: currentMode === 'video',
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    track = stream.getVideoTracks()[0];

    // Apply mirror for front camera
    video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';

    // Torch support
    const caps = track.getCapabilities?.() || {};
    if (caps.torch) {
      flashBtn.disabled = false;
    } else {
      flashBtn.disabled = true;
      flashOn = false;
      flashBtn.classList.remove('active');
    }

    // Zoom support
    if (caps.zoom) {
      zoomSlider.min = caps.zoom.min || 1;
      zoomSlider.max = Math.min(caps.zoom.max || 5, 8);
      zoomSlider.step = caps.zoom.step || 0.1;
      zoomSlider.disabled = false;
    } else {
      // CSS fallback still works
      zoomSlider.min = 1;
      zoomSlider.max = 3;
      zoomSlider.step = 0.1;
    }

    permissionScreen.classList.add('hidden');
    cameraView.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    showToast('Camera access denied or unavailable');
    alert('Could not access camera.\n\nMake sure you granted permission and are using HTTPS (or localhost).');
  }
}

// ===== Mode =====
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRecording) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    startCamera();
  });
});

// ===== Flash =====
flashBtn.addEventListener('click', async () => {
  if (!track) return;
  try {
    flashOn = !flashOn;
    await track.applyConstraints({ advanced: [{ torch: flashOn }] });
    flashBtn.classList.toggle('active', flashOn);
  } catch (e) {
    showToast('Flash not supported on this device');
    flashOn = false;
    flashBtn.classList.remove('active');
  }
});

// ===== Switch Camera =====
switchBtn.addEventListener('click', () => {
  if (isRecording) return;
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  flashOn = false;
  flashBtn.classList.remove('active');
  startCamera();
});

// ===== Zoom =====
zoomSlider.addEventListener('input', async () => {
  const zoom = parseFloat(zoomSlider.value);
  zoomValue.textContent = zoom.toFixed(1) + '×';

  if (track) {
    try {
      await track.applyConstraints({ advanced: [{ zoom }] });
      video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';
    } catch {
      // CSS fallback
      const base = facingMode === 'user' ? 'scaleX(-1) ' : '';
      video.style.transform = `${base}scale(${zoom})`;
    }
  }
});

// ===== Capture =====
shutterBtn.addEventListener('click', () => {
  if (currentMode === 'photo') {
    takePhoto();
  } else {
    isRecording ? stopRecording() : startRecording();
  }
});

function takePhoto() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (facingMode === 'user') {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);

  // Flash effect
  video.style.filter = 'brightness(1.8)';
  setTimeout(() => { video.style.filter = ''; }, 120);

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const id = Date.now() + Math.random().toString(36).slice(2);
    const item = {
      id,
      type: 'photo',
      blob,
      createdAt: Date.now()
    };
    await saveItem(item);
    mediaItems.unshift(item);
    updateGalleryThumb();
    showToast('Photo saved');
  }, 'image/jpeg', 0.92);
}

function startRecording() {
  if (!stream) return;
  recordedChunks = [];

  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  let options = {};
  for (const mime of mimeCandidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      options = { mimeType: mime };
      break;
    }
  }

  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch {
    mediaRecorder = new MediaRecorder(stream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    const id = Date.now() + Math.random().toString(36).slice(2);
    const item = {
      id,
      type: 'video',
      blob,
      createdAt: Date.now()
    };
    await saveItem(item);
    mediaItems.unshift(item);
    updateGalleryThumb();
    showToast('Video saved');
  };

  mediaRecorder.start(200);
  isRecording = true;
  shutterBtn.classList.add('recording');
  timerEl.classList.remove('hidden');
  seconds = 0;
  updateTimer();
  timerInterval = setInterval(() => {
    seconds++;
    updateTimer();
  }, 1000);
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    shutterBtn.classList.remove('recording');
    timerEl.classList.add('hidden');
    clearInterval(timerInterval);
  }
}

function updateTimer() {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
}

// ===== Gallery =====
function createObjectURL(item) {
  if (item._url) return item._url;
  item._url = URL.createObjectURL(item.blob);
  return item._url;
}

function updateGalleryThumb() {
  if (mediaItems.length === 0) {
    galleryThumb.classList.add('hidden');
    return;
  }
  const latest = mediaItems[0];
  galleryThumb.classList.remove('hidden');
  if (latest.type === 'photo') {
    galleryThumb.src = createObjectURL(latest);
  } else {
    // Generate video thumbnail
    const url = createObjectURL(latest);
    const tempVideo = document.createElement('video');
    tempVideo.src = url;
    tempVideo.muted = true;
    tempVideo.currentTime = 0.5;
    tempVideo.onloadeddata = () => {
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = 120;
      const ctx = c.getContext('2d');
      ctx.drawImage(tempVideo, 0, 0, 120, 120);
      galleryThumb.src = c.toDataURL('image/jpeg');
    };
  }
}

function renderGallery() {
  itemCount.textContent = mediaItems.length ? `(${mediaItems.length})` : '';

  if (mediaItems.length === 0) {
    galleryGrid.innerHTML = `
      <div class="empty-state">
        <div class="icon">📷</div>
        <p>No photos or videos yet</p>
        <p style="font-size:13px">Capture something to see it here</p>
      </div>`;
    return;
  }

  galleryGrid.innerHTML = mediaItems.map(item => {
    const url = createObjectURL(item);
    return `
      <div class="gallery-item" data-id="${item.id}">
        ${item.type === 'photo'
          ? `<img src="${url}" alt="Photo" loading="lazy">`
          : `<video src="${url}" muted preload="metadata"></video>`}
        <span class="badge">${item.type === 'photo' ? '📷' : '🎥'}</span>
        <button class="delete-btn" data-id="${item.id}" aria-label="Delete">×</button>
      </div>`;
  }).join('');

  galleryGrid.querySelectorAll('.gallery-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-btn')) return;
      openPreview(el.dataset.id);
    });
  });

  galleryGrid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeItem(btn.dataset.id);
    });
  });
}

async function removeItem(id) {
  const idx = mediaItems.findIndex(i => String(i.id) === String(id));
  if (idx === -1) return;

  const item = mediaItems[idx];
  if (item._url) URL.revokeObjectURL(item._url);
  mediaItems.splice(idx, 1);
  await deleteItemFromDB(id);
  updateGalleryThumb();
  renderGallery();
  if (String(currentPreviewId) === String(id)) closePreview();
  showToast('Deleted');
}

// Open / Close gallery
function openGallery() {
  cameraView.classList.add('hidden');
  galleryView.classList.remove('hidden');
  renderGallery();
}

function closeGallery() {
  galleryView.classList.add('hidden');
  cameraView.classList.remove('hidden');
}

galleryBtn.addEventListener('click', openGallery);
galleryThumb.addEventListener('click', openGallery);
$('#back-btn').addEventListener('click', closeGallery);

$('#clear-all-btn').addEventListener('click', async () => {
  if (mediaItems.length === 0) return;
  if (!confirm('Delete all photos and videos?')) return;
  mediaItems.forEach(i => { if (i._url) URL.revokeObjectURL(i._url); });
  mediaItems = [];
  await clearAllFromDB();
  updateGalleryThumb();
  renderGallery();
  showToast('Gallery cleared');
});

// ===== Preview =====
function openPreview(id) {
  const item = mediaItems.find(i => String(i.id) === String(id));
  if (!item) return;
  currentPreviewId = id;
  const url = createObjectURL(item);
  const content = $('#preview-content');
  content.innerHTML = item.type === 'photo'
    ? `<img src="${url}" alt="Preview">`
    : `<video src="${url}" controls autoplay playsinline></video>`;
  $('#preview-title').textContent = item.type === 'photo' ? 'Photo' : 'Video';
  previewModal.classList.remove('hidden');
}

function closePreview() {
  previewModal.classList.add('hidden');
  currentPreviewId = null;
  $('#preview-content').innerHTML = '';
}

$('#close-preview').addEventListener('click', closePreview);

$('#download-btn').addEventListener('click', () => {
  const item = mediaItems.find(i => String(i.id) === String(currentPreviewId));
  if (!item) return;
  const a = document.createElement('a');
  a.href = createObjectURL(item);
  const ext = item.type === 'photo' ? 'jpg' : (item.blob.type.includes('mp4') ? 'mp4' : 'webm');
  a.download = `camera-${item.type}-${new Date(item.createdAt).toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`;
  a.click();
  showToast('Downloading...');
});

$('#delete-preview-btn').addEventListener('click', async () => {
  if (currentPreviewId) await removeItem(currentPreviewId);
});

// ===== Init =====
$('#start-btn').addEventListener('click', startCamera);

async function init() {
  try {
    await openDB();
    const items = await loadAllItems();
    // Sort newest first
    mediaItems = items.sort((a, b) => b.createdAt - a.createdAt);
    updateGalleryThumb();
  } catch (e) {
    console.warn('IndexedDB not available', e);
  }
}

init();

// Cleanup
window.addEventListener('beforeunload', () => {
  if (stream) stream.getTracks().forEach(t => t.stop());
});
