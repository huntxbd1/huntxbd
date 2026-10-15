// ==================== FIREBASE CONFIG ====================
const firebaseConfig = {
    apiKey: "AIzaSyCmBNCZ7T3VUkerNH7xwuhJxNWRIOxQAy0",
    authDomain: "huntx-bd-app.firebaseapp.com",
    projectId: "huntx-bd-app",
    storageBucket: "huntx-bd-app.firebasestorage.app",
    messagingSenderId: "684817560300",
    appId: "1:684817560300:web:ec6c4e6debf8a49d782bc9",
    measurementId: "G-3YFGGCKZFM"
};

// Firebase init
let db = null;
let firebaseReady = false;

try {
    if (firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY") {
        firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        firebaseReady = true;
        console.log("Firebase connected");
    } else {
        console.warn("Firebase config missing — using localStorage fallback (single device only)");
    }
} catch (e) {
    console.error("Firebase init error:", e);
}

// ==================== DATA LAYER (Cloud + local fallback) ====================
const CACHE = {
    users: [],
    matches: [],
    joins: [],
    transactions: [],
    matchResults: [],
    settings: null,
    categories: null,
    modeRules: null,
    activePoll: null
};

const LocalDB = {
    get(key, def = null) {
        try {
            const val = localStorage.getItem('khelo_' + key);
            return val ? JSON.parse(val) : def;
        } catch { return def; }
    },
    set(key, val) {
        localStorage.setItem('khelo_' + key, JSON.stringify(val));
    }
};

// Generic helpers
async function cloudGetAll(collection) {
    if (!firebaseReady) return LocalDB.get(collection, []);
    const snap = await db.collection(collection).get();
    return snap.docs.map(d => ({ id: isNaN(d.id) ? d.id : (Number(d.id) || d.id), ...d.data(), _docId: d.id }));
}

async function cloudGetDoc(collection, id) {
    if (!firebaseReady) {
        const arr = LocalDB.get(collection, []);
        return arr.find(x => String(x.id) === String(id)) || null;
    }
    const docId = String(id);
    const snap = await db.collection(collection).doc(docId).get();
    if (!snap.exists) return null;
    return { id: isNaN(snap.id) ? snap.id : (Number(snap.id) || snap.id), ...snap.data(), _docId: snap.id };
}

async function cloudSet(collection, id, data) {
    const docId = String(id);
    const payload = { ...data };
    delete payload._docId;
    if (!firebaseReady) {
        let arr = LocalDB.get(collection, []);
        const idx = arr.findIndex(x => String(x.id) === docId);
        if (idx >= 0) arr[idx] = { ...arr[idx], ...payload, id: data.id ?? id };
        else arr.push({ ...payload, id: data.id ?? id });
        LocalDB.set(collection, arr);
        return;
    }
    await db.collection(collection).doc(docId).set(payload, { merge: true });
}

async function cloudDelete(collection, id) {
    const docId = String(id);
    if (!firebaseReady) {
        let arr = LocalDB.get(collection, []);
        arr = arr.filter(x => String(x.id) !== docId);
        LocalDB.set(collection, arr);
        return;
    }
    await db.collection(collection).doc(docId).delete();
}

async function cloudGetConfig(key, def = null) {
    if (!firebaseReady) return LocalDB.get(key, def);
    const snap = await db.collection('config').doc(key).get();
    if (!snap.exists) return def;
    return snap.data().value !== undefined ? snap.data().value : snap.data();
}

async function cloudSetConfig(key, value) {
    if (!firebaseReady) {
        LocalDB.set(key, value);
        return;
    }
    await db.collection('config').doc(key).set({ value });
}

// ==================== INIT DEFAULTS ====================
async function initDB() {
    // Settings
    let settings = await cloudGetConfig('settings', null);
    if (!settings) {
        settings = {
            supportTelegram: 'https://t.me/huntxbd',
            appName: 'HuntX BD',
            payments: {
                bKash: { number: '01700000000', type: 'Personal' },
                Nagad: { number: '01700000000', type: 'Personal' }
            },
            showJoinedPlayers: true,
            notice: '',
            popupNotice: '',
            referralMinDeposit: 100,
            referralBonus: 10
        };
        await cloudSetConfig('settings', settings);
    }
    if (!settings.payments) {
        settings.payments = {
            bKash: { number: '01700000000', type: 'Personal' },
            Nagad: { number: '01700000000', type: 'Personal' }
        };
    }
    CACHE.settings = settings;

    // Categories — only seed defaults on FIRST install (empty DB)
    // If admin deletes a mode, it must NOT come back automatically
    const DEFAULT_MODES = {
        'br-match': { title: 'BR MATCHES', name: 'BR Match', color: 'linear-gradient(135deg, #1a237e, #0d47a1)' },
        'br-survival': { title: 'BR SURVIVAL', name: 'BR Survival', color: 'linear-gradient(135deg, #e65100, #ff6f00)' },
        'clash-squad': { title: 'CLASH SQUAD', name: 'Clash Squad', color: 'linear-gradient(135deg, #4a148c, #7b1fa2)' },
        'cs-2vs2': { title: 'CS 2 VS 2', name: 'CS 2VS2', color: 'linear-gradient(135deg, #004d40, #00796b)' },
        'lone-wolf': { title: 'LONE WOLF', name: 'Lone Wolf', color: 'linear-gradient(135deg, #b71c1c, #d32f2f)' },
        'free-match': { title: 'FREE MATCH', name: 'Free Match', color: 'linear-gradient(135deg, #1b5e20, #388e3c)' }
    };
    let categories = await cloudGetConfig('categories', null);
    if (!categories || typeof categories !== 'object' || !Object.keys(categories).length) {
        categories = { ...DEFAULT_MODES };
        await cloudSetConfig('categories', categories);
    }
    CACHE.categories = categories;

    // Category display order — respect admin list; do not re-add deleted modes
    const defaultOrder = ['br-match', 'br-survival', 'clash-squad', 'cs-2vs2', 'lone-wolf', 'free-match'];
    let categoryOrder = await cloudGetConfig('categoryOrder', null);
    if (!Array.isArray(categoryOrder) || !categoryOrder.length) {
        // First install only — seed order once
        categoryOrder = defaultOrder.filter(k => categories[k]);
        Object.keys(categories).forEach(k => {
            if (!categoryOrder.includes(k)) categoryOrder.push(k);
        });
        await cloudSetConfig('categoryOrder', categoryOrder);
    } else {
        // Local-only normalize; NEVER auto-write (prevents multi-user wipe races)
        categoryOrder = categoryOrder.filter(k => categories[k] || String(k).startsWith('pro-'));
        Object.keys(categories).forEach(k => {
            if (!categoryOrder.includes(k)) categoryOrder.push(k);
        });
    }
    CACHE.categoryOrder = categoryOrder;

    // Mode rules
    let modeRules = await cloudGetConfig('modeRules', null);
    if (!modeRules) {
        modeRules = {
            'br-match': '<p>BR Match এর নিয়মাবলী এখানে লিখুন। অ্যাডমিন প্যানেল থেকে এডিট করতে পারবেন।</p>',
            'br-survival': '<p>BR Survival এর নিয়মাবলী এখানে লিখুন।</p>',
            'clash-squad': '<p>Clash Squad এর নিয়মাবলী এখানে লিখুন।</p>',
            'cs-2vs2': '<p>CS 2VS2 এর নিয়মাবলী এখানে লিখুন।</p>',
            'lone-wolf': '<p>Lone Wolf এর নিয়মাবলী এখানে লিখুন।</p>',
            'free-match': '<p>Free Match এর নিয়মাবলী এখানে লিখুন।</p>'
        };
        await cloudSetConfig('modeRules', modeRules);
    }
    CACHE.modeRules = modeRules;

    // Admin seed — do NOT load all users (huge reads). One-time local flag + light check.
    if (!CACHE.users) CACHE.users = [];
    try {
        const seeded = localStorage.getItem('hx_admin_seeded');
        if (!seeded && firebaseReady) {
            const q = await db.collection('users').where('username', '==', 'admin').limit(1).get();
            if (q.empty) {
                const adminUser = {
                    id: 1,
                    username: 'admin',
                    password: 'admin123',
                    phone: '01700000000',
                    email: 'admin@huntxbd.com',
                    nickname: 'Admin',
                    photo: '',
                    balance: 0,
                    isAdmin: true,
                    matchesJoined: 0,
                    totalWins: 0,
                    referralCode: 'ADMIN0001',
                    referredBy: null,
                    referralRewarded: false,
                    banned: false,
                    createdAt: new Date().toISOString()
                };
                await cloudSet('users', 1, adminUser);
                CACHE.users = [adminUser];
            }
            localStorage.setItem('hx_admin_seeded', '1');
        }
    } catch (e) {
        console.warn('admin seed skip', e);
    }

    // READ SAVER: no cloudGetAll for matches/joins/results on boot.
    // Listeners below load once (1x) instead of get+listen (2x).
    CACHE.matches = CACHE.matches || [];
    CACHE.joins = CACHE.joins || [];
    CACHE.transactions = CACHE.transactions || [];
    CACHE.matchResults = CACHE.matchResults || [];


    // Active poll (entry popup bot)
    try {
        CACHE.activePoll = await cloudGetConfig('activePoll', null);
    } catch (e) {
        CACHE.activePoll = null;
    }

    if (firebaseReady) {
        const _debounce = (fn, ms) => {
            let t = null;
            return (...args) => {
                clearTimeout(t);
                t = setTimeout(() => fn(...args), ms);
            };
        };
        const refreshMatchUI = _debounce(() => {
            try {
                if (currentCategory) renderMatches(currentCategory);
                updateCategoryCounts();
            } catch (e) { console.error(e); }
        }, 400);

        // Wait for first snapshot so UI has data (still 1 read wave, not 2)
        await new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            setTimeout(finish, 4000); // safety
            let mReady = false, jReady = false;
            const check = () => { if (mReady && jReady) finish(); };

            db.collection('matches').onSnapshot(snap => {
                CACHE.matches = snap.docs.map(d => ({ id: isNaN(d.id) ? d.id : (Number(d.id) || d.id), ...d.data(), _docId: d.id }));
                mReady = true; check();
                refreshMatchUI();
            });
            db.collection('joins').onSnapshot(snap => {
                const joins = snap.docs.map(d => ({ id: isNaN(d.id) ? d.id : (Number(d.id) || d.id), ...d.data(), _docId: d.id }));
                const byId = dedupeById(joins);
                const seenUM = new Set();
                CACHE.joins = byId.filter(j => {
                    const k = String(j.userId) + '_' + String(j.matchId);
                    if (seenUM.has(k)) return false;
                    seenUM.add(k);
                    return true;
                });
                jReady = true; check();
                refreshMatchUI();
            });
        });

        // Config docs = 1 read each (tiny)
        db.collection('config').doc('settings').onSnapshot(snap => {
            if (snap.exists) {
                CACHE.settings = snap.data().value !== undefined ? snap.data().value : snap.data();
                renderHomeNotice();
                applyAppLockGate();
            }
        });
        db.collection('config').doc('categories').onSnapshot(snap => {
            if (snap.exists) {
                const raw = snap.data().value !== undefined ? snap.data().value : snap.data();
                if (raw && typeof raw === 'object' && Object.keys(raw).length) {
                    CACHE.categories = raw;
                }
                renderPlayCategories();
            }
        });
        db.collection('config').doc('categoryOrder').onSnapshot(snap => {
            if (snap.exists) {
                const v = snap.data().value !== undefined ? snap.data().value : snap.data();
                if (Array.isArray(v)) {
                    CACHE.categoryOrder = v;
                    renderPlayCategories();
                }
            }
        });
        db.collection('config').doc('modeRules').onSnapshot(snap => {
            if (snap.exists) {
                CACHE.modeRules = snap.data().value !== undefined ? snap.data().value : snap.data();
            }
        });
        db.collection('config').doc('activePoll').onSnapshot(snap => {
            if (snap.exists) {
                CACHE.activePoll = snap.data().value !== undefined ? snap.data().value : snap.data();
            } else {
                CACHE.activePoll = null;
            }
        });
        // Results: load only when user opens Results page (saves reads for casual users)
        // Admin / Results page will call ensureMatchResultsListener()
    } else {
        // offline fallback
        const [matchesArr, joinsArr] = await Promise.all([
            cloudGetAll('matches'),
            cloudGetAll('joins')
        ]);
        CACHE.matches = matchesArr;
        CACHE.joins = dedupeById(joinsArr);
    }
}

let _matchResultsListening = false;
function ensureMatchResultsListener() {
    if (!firebaseReady || _matchResultsListening) return;
    _matchResultsListening = true;
    db.collection('matchResults').onSnapshot(snap => {
        CACHE.matchResults = dedupeById(snap.docs.map(d => ({ id: isNaN(d.id) ? d.id : (Number(d.id) || d.id), ...d.data(), _docId: d.id })));
        const rp = document.getElementById('results-page');
        if (rp && !rp.classList.contains('hidden')) loadResults();
    });
}

// Watch only logged-in user document (balance updates without loading all users)
let _unsubCurrentUser = null;
function watchCurrentUser() {
    if (!firebaseReady || !currentUser) return;
    try { if (_unsubCurrentUser) _unsubCurrentUser(); } catch (e) {}
    const docId = String(currentUser._docId || currentUser.id);
    _unsubCurrentUser = db.collection('users').doc(docId).onSnapshot(snap => {
        if (!snap.exists) return;
        const fresh = { id: isNaN(snap.id) ? snap.id : (Number(snap.id) || snap.id), ...snap.data(), _docId: snap.id };
        currentUser = fresh;
        // keep CACHE.users entry in sync if present
        const idx = (CACHE.users || []).findIndex(u => String(u.id) === String(fresh.id));
        if (idx >= 0) CACHE.users[idx] = fresh;
        else {
            if (!CACHE.users) CACHE.users = [];
            CACHE.users.push(fresh);
        }
        try { updateProfileUI(); } catch (e) {}
    }, err => console.warn('user watch', err));
}

async function loadAllUsersForAdmin() {
    if (!currentUser?.isAdmin) return [];
    const list = await cloudGetAll('users');
    CACHE.users = list;
    return list;
}


// ==================== STATE ====================
let currentUser = null;
let currentCategory = null;
let currentMatchId = null;
let currentDepositMethod = 'bKash';

// ---- Anti-duplicate (requests / pending / notifications) ----
const _recentRequestKeys = new Map();
function claimRequest(key, windowMs = 3000) {
    const now = Date.now();
    // cleanup old
    for (const [k, t] of _recentRequestKeys) {
        if (now - t > 15000) _recentRequestKeys.delete(k);
    }
    const prev = _recentRequestKeys.get(key);
    if (prev && (now - prev) < windowMs) return false;
    _recentRequestKeys.set(key, now);
    return true;
}

function dedupeById(arr) {
    const seen = new Set();
    const out = [];
    for (const item of (arr || [])) {
        const id = String(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(item);
    }
    return out;
}

function cachePushUnique(listName, item) {
    if (!CACHE[listName]) CACHE[listName] = [];
    if ((CACHE[listName] || []).some(x => String(x.id) === String(item.id))) return false;
    if (listName === 'transactions') CACHE.transactions.unshift(item);
    else CACHE[listName].push(item);
    return true;
}

/** Admin textarea: show rules as editable plain lines (keep emojis & spacing) */
function rulesToEditable(html) {
    if (!html) return '';
    return String(html)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<p[^>]*>/gi, '')
        .replace(/<div[^>]*>/gi, '')
        .replace(/<\/div>/gi, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n');
}

/** Display rules: preserve line breaks, emojis, and spacing exactly as typed */
function formatRulesHtml(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Already full HTML with many tags — only fix bare newlines
    if (/<(p|div|ul|ol|li|h[1-6])\b/i.test(s)) {
        return s.replace(/\n/g, '<br>');
    }
    // Plain text / emoji lines → safe HTML with line breaks
    s = s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    // Keep multiple spaces
    s = s.replace(/  /g, ' &nbsp;');
    s = s.replace(/\n/g, '<br>');
    return s;
}

// ==================== UTILS ====================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }


/** Open URL / Telegram — Chrome + AppGeyser Android WebView */
function openExternalLink(url) {
    if (!url) return;
    url = String(url).trim();
    if (!url) return;
    if (url.startsWith('t.me/')) url = 'https://' + url;
    if (url.startsWith('@')) url = 'https://t.me/' + url.slice(1);
    if (!/^https?:\/\//i.test(url) && !/^tg:/i.test(url) && !/^intent:/i.test(url)) {
        url = 'https://t.me/' + url.replace(/^\/+/, '');
    }

    var httpsUrl = url;
    var domain = null;
    var m = url.match(/t\.me\/([A-Za-z0-9_]+)/i);
    if (m) domain = m[1];

    // AppGeyser / Android WebView: Intent opens Telegram app (or Play Store / browser fallback)
    if (domain) {
        var intentUrl =
            'intent://resolve?domain=' + encodeURIComponent(domain) +
            '#Intent;scheme=tg;package=org.telegram.messenger;' +
            'S.browser_fallback_url=' + encodeURIComponent('https://t.me/' + domain) +
            ';end';
        try {
            // Primary: navigate via intent (WebView must allow external / intent)
            window.location.href = intentUrl;
            return;
        } catch (e0) {}
        try {
            var ai = document.createElement('a');
            ai.href = intentUrl;
            ai.style.display = 'none';
            document.body.appendChild(ai);
            ai.click();
            setTimeout(function () { try { ai.remove(); } catch (e) {} }, 800);
        } catch (e1) {}
        // tg:// deep link
        try { window.location.href = 'tg://resolve?domain=' + domain; } catch (e2) {}
    }

    // Fallback: https in new context
    try {
        var a = document.createElement('a');
        a.setAttribute('href', httpsUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.style.position = 'fixed';
        a.style.left = '-9999px';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { a.remove(); } catch (e) {} }, 1500);
    } catch (e3) {}
    try { window.open(httpsUrl, '_blank'); } catch (e4) {}
}

function getSupportTelegramUrl() {
    var settings = CACHE.settings || {};
    return (settings.supportTelegram || 'https://t.me/huntxbd').trim() || 'https://t.me/huntxbd';
}

function toast(msg, duration = 2500) {
    const text = String(msg || '');
    // Success popup ONLY inside Admin Panel
    const adminPage = document.getElementById('admin-page');
    const onAdmin = adminPage && !adminPage.classList.contains('hidden');
    const isSuccess = /saved|সফল|approved|যোগ হয়েছে|চেঞ্জ হয়েছে|uploaded|আপলোড|মুছে|deleted|Approve|সেভ|Success|success|কনফার্ম|Mode saved|স্লাইড|পাসওয়ার্ড/i.test(text);
    if (onAdmin && isSuccess) {
        showSuccessPopup(text, Math.max(duration, 1600));
        return;
    }
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), duration);
}

function showSuccessPopup(msg, duration = 1800) {
    let box = document.getElementById('success-popup');
    if (!box) {
        box = document.createElement('div');
        box.id = 'success-popup';
        box.className = 'success-popup';
        document.body.appendChild(box);
    }
    box.innerHTML = `
        <div class="success-popup-card">
            <div class="success-check"><i class="fas fa-check"></i></div>
            <p>${String(msg || 'সফল হয়েছে')}</p>
        </div>`;
    box.classList.add('show');
    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => box.classList.remove('show'), duration);
}


function updateNavBalance() {
    try {
        const bal = currentUser ? (Number(currentUser.balance) || 0) : 0;
        const el = document.getElementById('nav-balance-text');
        if (el) el.textContent = '৳' + bal;
        const chip = document.getElementById('nav-balance-chip');
        if (chip && !chip._bound) {
            chip._bound = true;
            chip.addEventListener('click', () => {
                if (currentUser) navigateTo('wallet');
            });
        }
    } catch (e) {}
}

function formatMoney(n) {
    return 'BDT ' + Number(n || 0).toLocaleString('en-BD');
}

function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('en-BD', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}


/** Withdrawable = prize/winning only (not deposit / admin add) */
function getWinningBalance(u) {
    if (!u) return 0;
    if (u.winningBalance != null && u.winningBalance !== '') {
        return Math.max(0, Number(u.winningBalance) || 0);
    }
    // one-time estimate for old accounts
    const est = Math.min(Math.max(0, Number(u.totalPrizeEarned) || 0), Math.max(0, Number(u.balance) || 0));
    return est;
}

function applyBalanceDelta(u, totalDelta, winningDelta) {
    const bal = Math.max(0, (Number(u.balance) || 0) + totalDelta);
    let win = getWinningBalance(u) + (winningDelta || 0);
    if (win < 0) win = 0;
    if (win > bal) win = bal;
    return { balance: bal, winningBalance: win };
}

/** Prefer spend deposit first, then winnings when paying entry fee */
function spendFromWallet(u, fee) {
    const bal = Number(u.balance) || 0;
    const win = getWinningBalance(u);
    const nonWin = Math.max(0, bal - win);
    let winDeduct = 0;
    if (fee > nonWin) winDeduct = Math.min(win, fee - nonWin);
    return {
        balance: bal - fee,
        winningBalance: Math.max(0, win - winDeduct)
    };
}



function timeUntil(iso) {
    const diff = new Date(iso) - new Date();
    if (diff <= 0) return 'Started';
    const totalSec = Math.floor(diff / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return h + 'h ' + m + 'm ' + ss + 's';
    return m + 'm ' + ss + 's';
}

function generateId() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// ==================== AUTH ====================
function showAuth() {
    $('#auth-container')?.classList.remove('hidden');
    $('#app-container')?.classList.add('hidden');
}


/** App closed for normal users; admin always allowed */
function isAppClosedForUsers() {
    const s = CACHE.settings || {};
    return !!s.appClosed;
}

function getAppClosedMessage() {
    const s = CACHE.settings || {};
    const msg = (s.appClosedMessage || '').trim();
    return msg || 'এই মুহূর্তে অ্যাপটি বন্ধ আছে।\nটেকনিক্যাল সমস্যার কারণে।\nদয়া করে পরে আবার চেষ্টা করুন।';
}

function applyAppLockGate() {
    const screen = document.getElementById('maintenance-screen');
    const msgEl = document.getElementById('maint-message');
    if (!screen) return;

    const closed = isAppClosedForUsers();
    const isAdmin = !!(currentUser && currentUser.isAdmin);

    // Not logged in → login screen (admin can sign in anytime)
    if (!currentUser) {
        screen.classList.add('hidden');
        $('#app-container')?.classList.add('hidden');
        $('#auth-container')?.classList.remove('hidden');
        $('#login-screen')?.classList.remove('hidden');
        $('#register-screen')?.classList.add('hidden');
        $('#forgot-screen')?.classList.add('hidden');
        return;
    }

    // Admin → full app, never blocked
    if (isAdmin) {
        screen.classList.add('hidden');
        return;
    }

    // Normal user + app closed → maintenance
    if (closed) {
        if (msgEl) msgEl.textContent = getAppClosedMessage();
        screen.classList.remove('hidden');
        $('#app-container')?.classList.add('hidden');
        $('#auth-container')?.classList.add('hidden');
        const okBtn = document.getElementById('maint-ok-btn');
        if (okBtn && !okBtn._bound) {
            okBtn._bound = true;
            okBtn.addEventListener('click', function () {
                // OK → logout + login panel (admin can login; users blocked again after login if still closed)
                currentUser = null;
                try { LocalDB.set('currentUser', null); } catch (e) {}
                screen.classList.add('hidden');
                $('#app-container')?.classList.add('hidden');
                $('#auth-container')?.classList.remove('hidden');
                $('#login-screen')?.classList.remove('hidden');
                $('#register-screen')?.classList.add('hidden');
                $('#forgot-screen')?.classList.add('hidden');
            });
        }
    } else {
        screen.classList.add('hidden');
    }
}

function showApp() {
    // Lock first — closed site must not open play / entry popup for users
    applyAppLockGate();
    if (isAppClosedForUsers() && !(currentUser && currentUser.isAdmin)) {
        // User blocked: only maintenance (or login after OK)
        $('#app-container')?.classList.add('hidden');
        return;
    }

    $('#auth-container')?.classList.add('hidden');
    $('#app-container')?.classList.remove('hidden');
    if (currentUser && !currentUser.referralCode) {
        ensureReferralCode();
    }
    watchCurrentUser();
    updateProfileUI();
    navigateTo('play', { instant: true });
    updateCategoryCounts();
    setTimeout(function () {
        // আগে পোল (যদি চালু ও ভোট না দিয়ে থাকে), নাহলে entry notice
        const poll = (typeof getActivePoll === 'function') ? getActivePoll() : null;
        const needPoll = poll && currentUser && !(typeof hasUserVotedPoll === 'function' && hasUserVotedPoll(poll, currentUser.id));
        if (needPoll) {
            showPollPopup();
        } else {
            showEntryPopup();
        }
    }, 450);
    // Shop telegram
    const settings = CACHE.settings || {};
    const shopLink = $('#shop-telegram-link');
    if (shopLink) {
        const tg = settings.supportTelegram || 'https://t.me/huntxbd';
        shopLink.href = tg;
        shopLink.target = '_blank';
        shopLink.rel = 'noopener noreferrer';
        shopLink.onclick = function (e) { e.preventDefault(); openExternalLink(tg); };
    }
}

async function ensureReferralCode() {
    if (!currentUser || currentUser.referralCode) return;
    const code = makeReferralCode(currentUser.username);
    currentUser.referralCode = code;
    await cloudSet('users', currentUser.id, { referralCode: code });
    const u = CACHE.users.find(x => String(x.id) === String(currentUser.id));
    if (u) u.referralCode = code;
}


// ==================== POLL BOT (entry popup) ====================
function getActivePoll() {
    const p = CACHE.activePoll;
    if (!p || !p.active || !p.question || !Array.isArray(p.options) || p.options.length < 2) return null;
    return p;
}

function hasUserVotedPoll(poll, userId) {
    if (!poll || userId == null) return false;
    const votes = poll.votes || {};
    return Object.prototype.hasOwnProperty.call(votes, String(userId));
}

function getPollCounts(poll) {
    const opts = poll.options || [];
    const votes = poll.votes || {};
    const counts = opts.map(() => 0);
    Object.keys(votes).forEach(uid => {
        const idx = Number(votes[uid]);
        if (!isNaN(idx) && idx >= 0 && idx < counts.length) counts[idx]++;
    });
    return counts;
}

function showPollPopup() {
    if (isAppClosedForUsers() && !(currentUser && currentUser.isAdmin)) return;
    if (!currentUser) return;
    const poll = getActivePoll();
    if (!poll) return;
    // Already voted → don't show again
    if (hasUserVotedPoll(poll, currentUser.id)) return;
    // Once per session if dismissed without vote
    const sk = 'hx_poll_skip_' + String(poll.id || 'x');
    try {
        if (sessionStorage.getItem(sk) === '1') return;
    } catch (e) {}

    const counts = getPollCounts(poll);
    const total = counts.reduce((a, b) => a + b, 0);
    const optionsHtml = poll.options.map((opt, i) => {
        const c = counts[i] || 0;
        const pct = total > 0 ? Math.round((c / total) * 100) : 0;
        const safe = String(opt).replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<button type="button" class="poll-opt-btn" data-idx="${i}"
            style="display:block;width:100%;text-align:left;margin:0 0 10px;padding:12px 14px;border-radius:12px;
            border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.28);color:#e8ecf8;cursor:pointer;position:relative;overflow:hidden;">
            <div style="position:relative;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span style="font-weight:600;font-size:14px;">○ ${safe}</span>
                <span style="font-size:12px;color:#8b93a7;">${c}</span>
            </div>
            <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:rgba(26,92,255,0.25);z-index:0;transition:width 0.3s;"></div>
        </button>`;
    }).join('');

    const q = String(poll.question).replace(/</g, '&lt;');
    showModal('📊 Poll', `
        <div style="text-align:left;">
            <p style="font-size:15px;font-weight:700;color:#f0f2f8;margin:0 0 14px;line-height:1.45;">${q}</p>
            <p style="font-size:11px;color:#8b93a7;margin:0 0 12px;">একবার ভোট দিলে আর বদলানো যাবে না</p>
            <div id="poll-options-box">${optionsHtml}</div>
        </div>
    `, [
        {
            text: 'পরে',
            class: 'btn-sm',
            action: function () {
                try { sessionStorage.setItem(sk, '1'); } catch (e) {}
                closeModal();
            }
        }
    ]);

    // Bind vote clicks after modal renders
    setTimeout(function () {
        const box = document.getElementById('poll-options-box');
        if (!box) return;
        box.querySelectorAll('.poll-opt-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                if (isNaN(idx)) return;
                castPollVote(idx);
            });
        });
    }, 50);
}

async function castPollVote(optionIndex) {
    if (!currentUser) return toast('লগইন করুন');
    if (window._pollVoting) return;
    const poll = getActivePoll();
    if (!poll) return toast('পোল নেই');
    if (hasUserVotedPoll(poll, currentUser.id)) {
        toast('আপনি ইতিমধ্যে ভোট দিয়েছেন');
        closeModal();
        return;
    }
    const opts = poll.options || [];
    if (optionIndex < 0 || optionIndex >= opts.length) return toast('ভুল অপশন');

    window._pollVoting = true;
    try {
        // Fresh read to avoid overwrite race
        let fresh = poll;
        try {
            const remote = await cloudGetConfig('activePoll', null);
            if (remote && remote.id === poll.id) fresh = remote;
        } catch (e) {}

        if (!fresh || !fresh.active) {
            toast('পোল বন্ধ');
            closeModal();
            return;
        }
        if (hasUserVotedPoll(fresh, currentUser.id)) {
            toast('আপনি ইতিমধ্যে ভোট দিয়েছেন');
            CACHE.activePoll = fresh;
            closeModal();
            return;
        }

        const votes = Object.assign({}, fresh.votes || {});
        votes[String(currentUser.id)] = optionIndex;
        const updated = Object.assign({}, fresh, {
            votes: votes,
            updatedAt: new Date().toISOString()
        });
        await cloudSetConfig('activePoll', updated);
        CACHE.activePoll = updated;
        toast('ভোট দেওয়া হয়েছে ✓');
        closeModal();
    } catch (e) {
        console.error(e);
        toast('ভোট ব্যর্থ — আবার চেষ্টা করুন');
    } finally {
        window._pollVoting = false;
    }
}

async function adminSavePoll() {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    const question = (document.getElementById('poll-q') && document.getElementById('poll-q').value || '').trim();
    const raw = (document.getElementById('poll-opts') && document.getElementById('poll-opts').value || '').trim();
    const active = !!(document.getElementById('poll-active') && document.getElementById('poll-active').checked);
    if (!question) return toast('প্রশ্ন লিখুন');
    const options = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (options.length < 2) return toast('কমপক্ষে ২টা অপশন লাইন দিয়ে লিখুন');
    if (options.length > 8) return toast('ম্যাক্স ৮টা অপশন');

    const prev = CACHE.activePoll || {};
    // New question/options → new poll id (resets votes). Same id if only toggling active on same text
    const same = prev.question === question && JSON.stringify(prev.options || []) === JSON.stringify(options);
    const poll = {
        id: same && prev.id ? prev.id : ('poll_' + Date.now()),
        question: question,
        options: options,
        active: active,
        votes: same ? (prev.votes || {}) : {},
        createdAt: same && prev.createdAt ? prev.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    try {
        await cloudSetConfig('activePoll', poll);
        CACHE.activePoll = poll;
        toast(active ? 'পোল সেভ + চালু ✓' : 'পোল সেভ (বন্ধ) ✓');
        if (typeof adminPanelNotify === 'function') adminPanelNotify('পোল আপডেট হয়েছে');
        loadAdmin('settings');
    } catch (e) {
        console.error(e);
        toast('সেভ ব্যর্থ');
    }
}

async function adminClosePoll() {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    const p = CACHE.activePoll;
    if (!p) return toast('কোনো পোল নেই');
    try {
        const updated = Object.assign({}, p, { active: false, updatedAt: new Date().toISOString() });
        await cloudSetConfig('activePoll', updated);
        CACHE.activePoll = updated;
        toast('পোল বন্ধ করা হয়েছে');
        loadAdmin('settings');
    } catch (e) {
        toast('ব্যর্থ');
    }
}

function showEntryPopup() {
    // App closed for this user → never show deposit/notice popup
    if (isAppClosedForUsers() && !(currentUser && currentUser.isAdmin)) return;
    const settings = CACHE.settings || {};
    const msg = (settings.popupNotice || '').trim();
    if (!msg) return;
    if (sessionStorage.getItem('hx_popup_shown') === '1') return;
    sessionStorage.setItem('hx_popup_shown', '1');
    showModal('📢 Notice', `
        <div style="font-size:14px;line-height:1.65;white-space:pre-wrap;text-align:left;">${msg.replace(/</g, '&lt;')}</div>
        <button class="btn-primary" style="margin-top:16px;width:100%;" onclick="closeModal()">Okay</button>
    `);
}

async function login(username, password) {
    try {
        // Refresh users
        CACHE.users = await cloudGetAll('users');
        const user = CACHE.users.find(u =>
            u.username.toLowerCase() === username.toLowerCase() && u.password === password
        );
        if (!user) {
            toast('ইউজারনেম বা পাসওয়ার্ড ভুল!');
            return false;
        }
        if (user.banned) {
            toast('আপনার অ্যাকাউন্ট ব্যান করা হয়েছে!');
            return false;
        }
        currentUser = user;
        LocalDB.set('currentUser', user.id);
        toast('লগইন সফল! স্বাগতম ' + user.username);
        showApp();
        return true;
    } catch (e) {
        console.error(e);
        toast('নেটওয়ার্ক সমস্যা। আবার চেষ্টা করুন।');
        return false;
    }
}

function makeReferralCode(username) {
    const base = (username || 'HX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'HUNTX';
    return base + String(Math.floor(1000 + Math.random() * 9000));
}

async function register(username, phone, password, email) {
    try {
        CACHE.users = await cloudGetAll('users');
        if (CACHE.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
            toast('এই ইউজারনেম ইতিমধ্যে আছে!');
            return false;
        }
        if (CACHE.users.find(u => u.phone === phone)) {
            toast('এই মোবাইল নম্বর ইতিমধ্যে রেজিস্টার করা আছে!');
            return false;
        }
        if (email && CACHE.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())) {
            toast('এই ইমেইল ইতিমধ্যে রেজিস্টার করা আছে!');
            return false;
        }
        const newUser = {
            id: generateId(),
            username,
            phone,
            email: (email || '').toLowerCase(),
            password,
            nickname: username,
            photo: '',
            balance: 0,
            isAdmin: false,
            matchesJoined: 0,
            totalWins: 0,
            banned: false,
            createdAt: new Date().toISOString()
        };
        await cloudSet('users', newUser.id, newUser);
        CACHE.users.push(newUser);
        currentUser = newUser;
        LocalDB.set('currentUser', newUser.id);
        toast('রেজিস্ট্রেশন সফল!');
        showApp();
        return true;
    } catch (e) {
        console.error(e);
        toast('রেজিস্ট্রেশন ব্যর্থ। নেট চেক করুন।');
        return false;
    }
}

function logout() {
    currentUser = null;
    LocalDB.set('currentUser', null);
    try { sessionStorage.removeItem('hx_popup_shown'); } catch (e) {}
    forceHideMiniLoader();
    showAuth();
    $('#login-screen')?.classList.remove('hidden');
    $('#register-screen')?.classList.add('hidden');
    $('#forgot-screen')?.classList.add('hidden');
}

async function checkSession() {
    const uid = LocalDB.get('currentUser');
    if (uid) {
        try {
            let user = await cloudGetDoc('users', uid);
            if (!user && firebaseReady) {
                // fallback: rare legacy id mismatch
                const all = await cloudGetAll('users');
                CACHE.users = all;
                user = all.find(u => String(u.id) === String(uid));
            } else if (user) {
                CACHE.users = CACHE.users || [];
                const i = CACHE.users.findIndex(u => String(u.id) === String(user.id));
                if (i >= 0) CACHE.users[i] = user;
                else CACHE.users.push(user);
            }
            currentUser = user || null;
            if (currentUser && !currentUser.banned) {
                watchCurrentUser();
                showApp();
                return;
            }
        } catch (e) {
            console.error(e);
        }
    }
    showAuth();
}

// ==================== NAVIGATION ====================
let _miniLoaderTimer = null;
function showMiniLoader(duration = 1) {
    const loader = document.getElementById('mini-loader');
    if (!loader) return Promise.resolve();
    const ms = Math.max(1, Math.min(Number(duration) || 1, 1200));
    loader.classList.remove('hidden', 'fade-out');
    return new Promise(resolve => {
        clearTimeout(_miniLoaderTimer);
        _miniLoaderTimer = setTimeout(() => {
            try {
                loader.classList.add('hidden');
                loader.classList.remove('fade-out');
                resolve();
            } catch (e) {
                try { loader.classList.add('hidden'); } catch (e2) {}
                resolve();
            }
        }, ms);
    });
}

function forceHideMiniLoader() {
    try {
        clearTimeout(_miniLoaderTimer);
        const loader = document.getElementById('mini-loader');
        if (loader) {
            loader.classList.add('hidden');
            loader.classList.remove('fade-out');
        }
    } catch (e) {}
}

// In-app history so phone Back closes feature, not the whole app
let appNavStack = ['play'];
let currentAppPage = 'play';
let _navFromPop = false;

function navigateTo(page, opts = {}) {
    const doNav = () => {
        $$('.page').forEach(p => p.classList.add('hidden'));
        $$('.nav-item').forEach(n => n.classList.remove('active'));

        const pageMap = {
            'play': 'play-page',
            'pro-league': 'match-list-page',
            'shop': 'shop-page',
            'my-matches': 'my-matches-page',
            'results': 'results-page',
            'profile': 'profile-page',
            'edit-profile': 'edit-profile-page',
            'match-list': 'match-list-page',
            'match-detail': 'match-detail-page',
            'wallet': 'wallet-page',
            'deposit': 'deposit-page',
            'withdraw': 'withdraw-page',
            'rules': 'rules-page',
            'admin': 'admin-page',
            'top-players': 'top-players-page',
            'tx-history': 'tx-history-page'
        };

        const el = $('#' + (pageMap[page] || page));
        if (el) el.classList.remove('hidden');

        const nav = $(`.nav-item[data-page="${page}"]`);
        if (nav) nav.classList.add('active');
        // highlight play for match-list from normal modes
        if (page === 'match-list' && currentCategory && !isProLeagueCategory(currentCategory)) {
            $(`.nav-item[data-page="play"]`)?.classList.add('active');
        }
        if (page === 'match-list' && currentCategory && isProLeagueCategory(currentCategory)) {
            $(`.nav-item[data-page="pro-league"]`)?.classList.add('active');
        }

        const banner = $('#top-banner');
        if (banner) {
            if (['play', 'shop'].includes(page)) banner.style.display = 'block';
            else banner.style.display = 'none';
        }

        if (page === 'play') {
            renderHomeNotice();
            try { renderPlayCategories(); } catch (e) { console.error(e); }
            try { if (typeof renderHomeSlider === 'function') renderHomeSlider(); } catch (e2) {}
        }
        if (page === 'pro-league') {
            openProLeagueHome();
        }
        if (page === 'my-matches') {
            try { loadMyMatches(); } catch (e) { console.error(e); }
        }
        if (page === 'results') loadResults();
        if (page === 'profile') updateProfileUI();
        if (page === 'wallet') loadWallet();
        if (page === 'tx-history') loadTxHistory();
        updateNavBalance();
        if (page === 'withdraw') clearWithdrawForm();
        if (page === 'deposit') clearDepositForm();
        if (page === 'rules') loadRules();
        if (page === 'admin') loadAdmin('matches');
        if (page === 'top-players') loadTopPlayers();
        if (page === 'deposit') {
            renderDepositInstructions(currentDepositMethod || 'bKash');
            document.querySelectorAll('.dep-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.method === (currentDepositMethod || 'bKash'));
            });
        }

        currentAppPage = page;
        if (!_navFromPop && !opts.fromBack) {
            const top = appNavStack[appNavStack.length - 1];
            if (top !== page) {
                appNavStack.push(page);
                try {
                    history.pushState({ app: true, page, category: currentCategory, stack: appNavStack.slice() }, '', '#' + page);
                } catch (e) {}
            }
        }
        _navFromPop = false;
    };

    // Loader ONLY for bottom-nav change + category click (opts.loader === true)
    if (opts.instant || !opts.loader) {
        doNav();
        forceHideMiniLoader();
        return;
    }
    showMiniLoader(opts.duration != null ? opts.duration : 1);
    try { doNav(); } catch (e) { console.error(e); }
    setTimeout(forceHideMiniLoader, 50);
}

function handleAppBack() {
    // Close modal first
    const modal = document.getElementById('modal');
    if (modal && !modal.classList.contains('hidden')) {
        closeModal();
        try { history.pushState({ app: true, page: currentAppPage, category: currentCategory }, '', '#' + currentAppPage); } catch (e) {}
        return true;
    }
    if (appNavStack.length > 1) {
        appNavStack.pop();
        const prev = appNavStack[appNavStack.length - 1] || 'play';
        _navFromPop = true;
        if (prev === 'play') currentCategory = null;
        if (prev === 'pro-league') currentCategory = null;
        navigateTo(prev, { fromBack: true, instant: true });
        return true;
    }
    // At root — keep one extra state so first back stays in app (second back can leave)
    try { history.pushState({ app: true, page: 'play' }, '', '#play'); } catch (e) {}
    return true;
}

window.addEventListener('popstate', function (e) {
    handleAppBack();
});


// ==================== PROFILE ====================
function updateProfileUI() {
    if (!currentUser) return;
    const fresh = CACHE.users.find(u => String(u.id) === String(currentUser.id));
    if (fresh) currentUser = fresh;

    const displayName = currentUser.nickname || currentUser.username;
    const nameEl = $('#profile-display-name');
    const subEl = $('#profile-username-sub');
    if (nameEl) {
        if (currentUser.verified) {
            nameEl.innerHTML = displayName + ' <span title="Verified" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#1d9bf0;color:#fff;font-size:11px;vertical-align:middle;margin-left:4px;">✓</span>';
        } else {
            nameEl.textContent = displayName;
        }
    }
    if (subEl) subEl.textContent = '@' + currentUser.username;

    $('#stat-matches') && ($('#stat-matches').textContent = currentUser.matchesJoined || 0);
    $('#stat-balance') && ($('#stat-balance').textContent = formatMoney(currentUser.balance || 0));
    updateNavBalance();
    $('#stat-wins') && ($('#stat-wins').textContent = String(getUserPrizeEarned(currentUser)));

    const avatarEl = $('#profile-avatar-display');
    if (avatarEl) {
        if (currentUser.photo) {
            avatarEl.innerHTML = `<img src="${currentUser.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        } else {
            avatarEl.innerHTML = `<i class="fas fa-user"></i>`;
        }
    }

    const adminMenu = $('#menu-admin');
    if (adminMenu) {
        if (currentUser.isAdmin) adminMenu.classList.remove('hidden');
        else adminMenu.classList.add('hidden');
    }
}

function openEditProfile() {
    if (!currentUser) return;
    navigateTo('edit-profile');
    const un = currentUser.username || '';
    const nick = currentUser.nickname || un;
    if ($('#edit-username')) $('#edit-username').value = un;
    if ($('#edit-nickname')) $('#edit-nickname').value = nick;
    if ($('#edit-phone')) $('#edit-phone').value = currentUser.phone || '';
    if ($('#edit-email')) $('#edit-email').value = currentUser.email || '—';
    if ($('#myprofile-display-name')) {
        $('#myprofile-display-name').textContent = nick + (currentUser.verified ? ' ✓' : '');
    }
    if ($('#myprofile-email')) $('#myprofile-email').textContent = currentUser.email || '';
    if ($('#my-current-pass')) $('#my-current-pass').value = '';
    if ($('#my-new-pass')) $('#my-new-pass').value = '';
    if ($('#my-confirm-pass')) $('#my-confirm-pass').value = '';

    const preview = $('#edit-avatar-preview');
    if (preview) {
        if (currentUser.photo) {
            preview.innerHTML = `<img src="${currentUser.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        } else {
            preview.innerHTML = `<i class="fas fa-user"></i>`;
        }
    }
}

async function changeMyPassword() {
    if (!currentUser) return;
    const cur = ($('#my-current-pass')?.value || '').trim();
    const nw = ($('#my-new-pass')?.value || '').trim();
    const cf = ($('#my-confirm-pass')?.value || '').trim();
    if (!cur) return toast('বর্তমান পাসওয়ার্ড দিন');
    if (!nw || nw.length < 4) return toast('নতুন পাসওয়ার্ড অন্তত ৪ অক্ষর');
    if (nw !== cf) return toast('নতুন পাসওয়ার্ড মিলছে না');

    const fresh = await cloudGetDoc('users', currentUser.id);
    if (!fresh) return toast('ইউজার পাওয়া যায়নি');
    const stored = String(fresh.password || '');
    if (stored && cur !== stored) return toast('বর্তমান পাসওয়ার্ড ভুল');

    await cloudSet('users', currentUser.id, { password: nw });
    currentUser.password = nw;
    const cu = (CACHE.users || []).find(x => String(x.id) === String(currentUser.id));
    if (cu) cu.password = nw;
    if ($('#my-current-pass')) $('#my-current-pass').value = '';
    if ($('#my-new-pass')) $('#my-new-pass').value = '';
    if ($('#my-confirm-pass')) $('#my-confirm-pass').value = '';
    toast('পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে');
}

async function saveProfile() {
    const nickname = $('#edit-nickname').value.trim();
    if (!nickname || nickname.length < 2) return toast('নিকনেম কমপক্ষে ২ অক্ষরের হতে হবে');

    currentUser.nickname = nickname;
    await cloudSet('users', currentUser.id, { nickname });
    const u = CACHE.users.find(x => String(x.id) === String(currentUser.id));
    if (u) u.nickname = nickname;
    toast('প্রোফাইল আপডেট হয়েছে!');
    updateProfileUI();
    navigateTo('profile');
}

function handlePhotoUpload(e) {
    // Profile gallery upload disabled — reduces Firebase storage risk
    toast('প্রোফাইল ছবি আপলোড বন্ধ আছে');
    if (e && e.target) e.target.value = '';
}

// ==================== CATEGORIES & MATCHES ====================

const PRO_LEAGUE_MODES = {
    'pro-champion-rush': {
        title: 'CHAMPION RUSH',
        name: 'Champion Rush',
        color: 'linear-gradient(135deg, #e10600, #1a5cff)',
        seriesMatches: 6,
        desc: '৬ ম্যাপ'
    },
    'pro-point-rush': {
        title: 'POINT RUSH',
        name: 'Point Rush',
        color: 'linear-gradient(135deg, #00b894, #1a5cff)',
        seriesMatches: 6,
        desc: '৬ ম্যাপ'
    },
    'pro-scrim': {
        title: 'SCRIM',
        name: 'Scrim',
        color: 'linear-gradient(135deg, #2a0a12, #e10600)',
        seriesMatches: 3,
        desc: '৩ ম্যাপ'
    },
    'pro-qualified': {
        title: 'QUALIFIED',
        name: 'Qualified Tournament',
        color: 'linear-gradient(135deg, #fdcb6e, #e10600)',
        seriesMatches: 6,
        desc: '৬ ম্যাপ · Groups'
    },
    'pro-versus': {
        title: 'VERSUS',
        name: 'Versus',
        color: 'linear-gradient(135deg, #a29bfe, #e10600)',
        seriesMatches: 1,
        desc: 'Team vs Team'
    }
};

/** Fixed display order for Pro League home */
const PRO_LEAGUE_ORDER = ['pro-champion-rush', 'pro-point-rush', 'pro-scrim', 'pro-qualified'];

function isProLeagueCategory(cat) {
    const c = String(cat || '');
    return c === 'pro-league' || c.startsWith('pro-') || !!PRO_LEAGUE_MODES[c];
}

async function ensureProLeagueCategory() {
    // SAFE: always read latest from cloud before any write.
    // Never overwrite thumbs/rules with empty client CACHE (multi-user race fix).
    let cats = null;
    try { cats = await cloudGetConfig('categories', null); } catch (e) { cats = null; }
    if (!cats || typeof cats !== 'object') cats = { ...(CACHE.categories || {}) };
    let changed = false;
    Object.keys(PRO_LEAGUE_MODES).forEach(k => {
        if (!cats[k]) {
            const m = PRO_LEAGUE_MODES[k];
            cats[k] = { title: m.title, name: m.name, color: m.color, thumb: '' };
            changed = true;
        } else {
            const m = PRO_LEAGUE_MODES[k];
            if (!cats[k].title) { cats[k].title = m.title; changed = true; }
            if (!cats[k].name) { cats[k].name = m.name; changed = true; }
            if (!cats[k].color) { cats[k].color = m.color; changed = true; }
            // NEVER clear existing thumb
        }
    });
    CACHE.categories = { ...(CACHE.categories || {}), ...cats };
    if (changed) {
        // Merge-write: re-fetch once more to avoid clobbering concurrent admin thumb upload
        try {
            const latest = await cloudGetConfig('categories', null) || {};
            Object.keys(cats).forEach(k => {
                if (!latest[k]) latest[k] = cats[k];
                else {
                    // keep server thumb/name if present
                    if (latest[k].thumb) cats[k].thumb = latest[k].thumb;
                    if (!latest[k].title) latest[k].title = cats[k].title;
                    if (!latest[k].name) latest[k].name = cats[k].name;
                    if (!latest[k].color) latest[k].color = cats[k].color;
                }
            });
            Object.keys(cats).forEach(k => { if (!latest[k]) latest[k] = cats[k]; });
            await cloudSetConfig('categories', latest);
            CACHE.categories = latest;
        } catch (e) {
            console.warn('ensureProLeague categories write skipped', e);
        }
    }

    // categoryOrder — local only unless missing pro keys and admin-less seed needed
    const order = Array.isArray(CACHE.categoryOrder) ? CACHE.categoryOrder.slice() : [];
    let orderChanged = false;
    Object.keys(PRO_LEAGUE_MODES).forEach(k => {
        if (!order.includes(k)) { order.push(k); orderChanged = true; }
    });
    CACHE.categoryOrder = order;
    // Do NOT auto cloudSetConfig categoryOrder here (race-safe)

    // modeRules — only ADD missing pro keys; never replace whole object from empty CACHE
    let modeRules = null;
    try { modeRules = await cloudGetConfig('modeRules', null); } catch (e) { modeRules = null; }
    if (!modeRules || typeof modeRules !== 'object') modeRules = { ...(CACHE.modeRules || {}) };
    let rulesChanged = false;
    Object.keys(PRO_LEAGUE_MODES).forEach(k => {
        if (!modeRules[k] || !String(modeRules[k]).trim()) {
            const m = PRO_LEAGUE_MODES[k];
            modeRules[k] = `<p><strong>${m.name}</strong> — Pro League। ${m.desc}। জয়েন: টিম নাম, IGL, WhatsApp (লোগো অপশনাল)।</p>`;
            rulesChanged = true;
        }
    });
    CACHE.modeRules = { ...(CACHE.modeRules || {}), ...modeRules };
    if (rulesChanged) {
        try {
            const latest = await cloudGetConfig('modeRules', null) || {};
            Object.keys(modeRules).forEach(k => {
                // only fill empty keys on server — never overwrite existing admin rules
                if (!latest[k] || !String(latest[k]).trim()) latest[k] = modeRules[k];
            });
            await cloudSetConfig('modeRules', latest);
            CACHE.modeRules = latest;
        } catch (e) {
            console.warn('ensureProLeague rules write skipped', e);
        }
    }
}

async function openProLeagueHome() {
    await ensureProLeagueCategory();
    currentCategory = null;
    $$('.page').forEach(p => p.classList.add('hidden'));
    const page = $('#match-list-page');
    if (page) page.classList.remove('hidden');
    const title = $('#match-list-title');
    if (title) title.textContent = 'PRO LEAGUE';
    const container = $('#matches-container');
    if (!container) return;
    const matches = CACHE.matches || [];
    const keys = (typeof PRO_LEAGUE_ORDER !== 'undefined' ? PRO_LEAGUE_ORDER : Object.keys(PRO_LEAGUE_MODES))
        .filter(k => PRO_LEAGUE_MODES[k]);
    // Versus matches sit on TOP of Pro League (not a category tile)
    const versusMatches = matches.filter(x =>
        String(x.category) === 'pro-versus' && isActiveMatch(x)
    );
    let versusHtml = '';
    if (versusMatches.length) {
        versusHtml = `
        <p style="text-align:center;font-size:14px;font-weight:800;color:#fdcb6e;margin:4px 0 10px;letter-spacing:1px;">VERSUS</p>
        <div class="versus-home-list" style="margin-bottom:18px;">
            ${versusMatches.map(m => {
                const tA = (m.teamALogo || '').trim();
                const tB = (m.teamBLogo || '').trim();
                const nA = (m.teamAName || 'Team A').replace(/</g, '');
                const nB = (m.teamBName || 'Team B').replace(/</g, '');
                const startStr = formatTime(m.startTime);
                const filled = getJoinedCount(m.id);
                const total = m.maxPlayers || 48;
                const isFull = filled >= total;
                const isJoined = isUserJoined(m.id);
                const joinBtn = isJoined
                    ? `<button class="btn-join" disabled style="opacity:0.95;cursor:default;">Joined</button>`
                    : (m.registrationClosed
                        ? `<button class="btn-join full" disabled style="background:#636e72;font-size:11px;">Registration Closed</button>`
                        : isFull
                            ? `<button class="btn-join full" disabled>Match Full</button>`
                            : `<button class="btn-join" onclick="joinMatch(${m.id})">Join</button>`);
                return `
                <div class="match-card pro-match-card versus-card" style="margin-bottom:12px;cursor:pointer;" onclick="openMatchDetails(${m.id})">
                    <div class="pro-match-time"><i class="fas fa-calendar-alt"></i> ${startStr}</div>
                    <div class="pro-vs-row pro-vs-big" onclick="event.stopPropagation()">
                        <div class="pro-vs-team">
                            ${isUsableThumbUrl(tA) ? `<img src="${tA}" alt="">` : `<div class="pro-vs-ph">A</div>`}
                            <span>${nA}</span>
                        </div>
                        <div class="pro-vs-mid">VS</div>
                        <div class="pro-vs-team">
                            ${isUsableThumbUrl(tB) ? `<img src="${tB}" alt="">` : `<div class="pro-vs-ph">B</div>`}
                            <span>${nB}</span>
                        </div>
                    </div>
                    <div class="pro-match-title">${(m.title || 'Versus').replace(/</g, '')}</div>
                    <div class="versus-prize-row">
                        <div class="versus-prize-box"><span class="lbl">WIN PRIZE</span><span class="val prize">${m.winPrize || 0} TK</span></div>
                        <div class="versus-prize-box"><span class="lbl">ENTRY FEE</span><span class="val fee">${m.entryFee || 0} TK</span></div>
                    </div>
                    <div class="match-progress" style="margin:8px 0;">
                        <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, (filled/total)*100)}%"></div></div>
                        <div class="progress-info">
                            <span>${isFull ? 'Only 0 spots are left' : ('Only ' + (total - filled) + ' spots are left')}</span>
                            <span>${filled}/${total} Joined</span>
                        </div>
                    </div>
                    <div class="match-actions versus-actions" onclick="event.stopPropagation()">
                        <button class="btn-room" onclick="showRoomDetails(${m.id})"><i class="fas fa-key"></i> Room Details</button>
                        <button class="btn-prize" onclick="showPrizeDetails(${m.id})"><i class="fas fa-trophy"></i> Prize</button>
                        ${joinBtn}
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    }

    const modeKeys = keys.filter(k => k !== 'pro-versus');
    container.innerHTML = `
        ${versusHtml}
        <p style="text-align:center;font-size:13px;color:#8b93a7;margin-bottom:12px;">Pro League Modes</p>
        <div class="pro-league-grid">
            ${modeKeys.map(key => {
                const m = PRO_LEAGUE_MODES[key];
                const cat = (getCategories() || {})[key] || {};
                const count = matches.filter(x => x.category === key && isActiveMatch(x)).length;
                const thumb = isUsableThumbUrl(cat.thumb) ? (cat.thumb || '').trim() : '';
                const displayName = cat.name || m.name;
                const inner = thumb
                    ? `<img src="${thumb}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"
                        onerror="this.style.display='none';const l=this.parentNode.querySelector('.cat-label');if(l)l.style.display='flex';">
                       <span class="cat-label" style="display:none;">${displayName}</span>`
                    : `<span class="cat-label">${displayName}</span>`;
                return `
                <div class="category-card pro-square-card" onclick="openCategory('${key}')">
                    <div class="cat-img" style="background:${m.color};overflow:hidden;position:relative;">
                        ${inner}
                    </div>
                    <div class="cat-info">
                        <h3>${displayName}</h3>
                        <p class="matches-count">${m.desc} · ${count}</p>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}


const DEFAULT_CAT_ORDER = ['br-match', 'br-survival', 'clash-squad', 'cs-2vs2', 'lone-wolf', 'free-match'];

function getCategories() {
    return CACHE.categories || {};
}

/** Always return modes in fixed admin order (Firestore object key order is unstable) */
function getCategoryKeys() {
    const cats = getCategories();
    const keys = Object.keys(cats || {});
    let order = CACHE.categoryOrder;
    if (!Array.isArray(order) || !order.length) {
        order = DEFAULT_CAT_ORDER.slice();
    }
    const ordered = [];
    order.forEach(k => {
        if (keys.includes(k) && !ordered.includes(k)) ordered.push(k);
    });
    keys.forEach(k => {
        if (!ordered.includes(k)) ordered.push(k);
    });
    return ordered;
}

function renderHomeNotice() {
    const settings = CACHE.settings || {};
    const play = document.getElementById('play-page');
    if (!play) return;

    // Notice banner
    let el = document.getElementById('home-notice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'home-notice';
        const header = play.querySelector('.page-header-text');
        if (header) header.insertAdjacentElement('afterend', el);
        else play.insertBefore(el, play.firstChild);
    }
    if (settings.notice) {
        el.className = 'home-notice';
        el.innerHTML = '<i class="fas fa-bullhorn"></i> ' + settings.notice;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
        el.innerHTML = '';
    }

    // Telegram channel bar (always visible, clickable — AppGeyser safe)
    let tgBar = document.getElementById('home-telegram-bar');
    if (!tgBar) {
        tgBar = document.createElement('a');
        tgBar.id = 'home-telegram-bar';
        tgBar.className = 'home-telegram-bar';
        tgBar.target = '_blank';
        tgBar.rel = 'noopener noreferrer';
        const after = el && el.parentNode ? el : play.querySelector('.page-header-text');
        if (after && after.parentNode) after.insertAdjacentElement('afterend', tgBar);
        else play.insertBefore(tgBar, play.firstChild);
        tgBar.addEventListener('click', function (e) {
            e.preventDefault();
            openExternalLink(getSupportTelegramUrl());
        });
    }
    const tgUrl = getSupportTelegramUrl();
    tgBar.href = tgUrl;
    tgBar.innerHTML = '<i class="fab fa-telegram-plane"></i> <span>' + tgUrl.replace(/^https?:\/\//, '') + '</span>';

    // Home ultimate slider
    if (typeof renderHomeSlider === 'function') renderHomeSlider();
}


function updateCategoryCounts() {
    renderPlayCategories();
}

function isUsableThumbUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim();
    if (!u) return false;
    // Allow embedded base64 images (from file upload)
    if (/^data:image\//i.test(u)) return true;
    if (!/^https?:\/\//i.test(u)) return false;
    const low = u.toLowerCase();
    // These hosts often return a 404 IMAGE (HTTP 200) — skip so gradient shows
    if (low.includes('freeimage.host')) return false;
    if (low.includes('iili.io')) return false;
    if (low.includes('example.com')) return false;
    return true;
}

/** Compress image file → data URL (jpeg) for Firebase/localStorage */
function fileToThumbDataUrl(file, maxW = 720, quality = 0.85) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('শুধু ইমেজ ফাইল দিন'));
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            reject(new Error('ইমেজ ৮ MB এর কম হতে হবে'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('ফাইল পড়া যায়নি'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('ইমেজ লোড ব্যর্থ'));
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxW) {
                    h = Math.round(h * (maxW / w));
                    w = maxW;
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                try {
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (e) {
                    reject(e);
                }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function adminUploadModeThumb(key, inputEl) {
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;
    try {
        toast('ইমেজ প্রসেস হচ্ছে...');
        // Wide Pro League / mode banners — higher res & quality
        const dataUrl = await fileToThumbDataUrl(file, 1280, 0.92);
        const cats = getCategories();
        if (!cats[key]) return toast('Mode not found');
        // Merge with server so concurrent users don't wipe other thumbs
        let latest = {};
        try { latest = await cloudGetConfig('categories', null) || {}; } catch (e) { latest = {}; }
        if (typeof latest !== 'object' || !latest) latest = { ...cats };
        if (!latest[key]) latest[key] = { ...(cats[key] || {}) };
        latest[key] = { ...latest[key], ...cats[key], thumb: dataUrl };
        CACHE.categories = latest;
        await cloudSetConfig('categories', latest);
        toast('Thumbnail আপলোড হয়েছে: ' + (latest[key].name || key));
        renderPlayCategories();
        loadAdmin('rules');
    } catch (err) {
        console.error(err);
        toast(err.message || 'আপলোড ব্যর্থ');
    } finally {
        if (inputEl) inputEl.value = '';
    }
}


function renderPlayCategories() {
    let cats = getCategories();
    const matches = CACHE.matches || [];
    const container = $('.match-categories');
    if (!container) return;
    // If categories empty locally — show defaults in UI only. NEVER write to Firebase
    // (auto-write caused multi-user wipe of thumbs & custom data)
    const normalKeys = getCategoryKeys().filter(cat => !isProLeagueCategory(cat) && cats[cat]);
    if (!normalKeys.length) {
        const DEFAULT_MODES = {
            'br-match': { title: 'BR MATCHES', name: 'BR Match', color: 'linear-gradient(135deg, #1a237e, #0d47a1)' },
            'br-survival': { title: 'BR SURVIVAL', name: 'BR Survival', color: 'linear-gradient(135deg, #e65100, #ff6f00)' },
            'clash-squad': { title: 'CLASH SQUAD', name: 'Clash Squad', color: 'linear-gradient(135deg, #4a148c, #7b1fa2)' },
            'cs-2vs2': { title: 'CS 2 VS 2', name: 'CS 2VS2', color: 'linear-gradient(135deg, #004d40, #00796b)' },
            'lone-wolf': { title: 'LONE WOLF', name: 'Lone Wolf', color: 'linear-gradient(135deg, #b71c1c, #d32f2f)' },
            'free-match': { title: 'FREE MATCH', name: 'Free Match', color: 'linear-gradient(135deg, #1b5e20, #388e3c)' }
        };
        cats = { ...DEFAULT_MODES, ...(cats || {}) };
        // local display only — do not cloudSetConfig
    }
    const fallbackBg = (c) => (c && c.color) || 'linear-gradient(135deg,#6c5ce7,#a29bfe)';
    const html = getCategoryKeys().filter(cat => !isProLeagueCategory(cat)).map(cat => {
        const c = cats[cat];
        if (!c) return '';
        const count = matches.filter(m => m.category === cat && isActiveMatch(m)).length;
        const thumb = isUsableThumbUrl(c.thumb) ? (c.thumb || '').trim() : '';
        const inner = thumb
            ? `<img src="${thumb}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"
                onerror="this.style.display='none';const l=this.parentNode.querySelector('.cat-label');if(l)l.style.display='flex';">
               <span class="cat-label" style="display:none;">${c.name || cat}</span>`
            : `<span class="cat-label">${c.name || cat}</span>`;
        return `
        <div class="category-card" data-category="${cat}" onclick="openCategory('${cat}')">
            <div class="cat-img" style="background:${fallbackBg(c)};overflow:hidden;position:relative;">
                ${inner}
            </div>
            <div class="cat-info">
                <h3>${c.name || cat}</h3>
                <p class="matches-count">${count} matches found</p>
            </div>
        </div>`;
    }).join('');
    container.innerHTML = html || `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-gamepad"></i><p>কোনো মোড নেই — অ্যাডমিন থেকে মোড অ্যাড করুন</p></div>`;
}

function openCategory(cat) {
    currentCategory = cat;
    const cats = getCategories();
    $('#match-list-title').textContent = cats[cat]?.title || cat.toUpperCase();
    navigateTo('match-list', { loader: true, duration: 1 });
    setTimeout(() => renderMatches(cat), 80);
}

function renderMatches(cat) {
    const container = $('#matches-container');
    if (!container) return;
    const matches = (CACHE.matches || [])
        .filter(m => m.category === cat && isActiveMatch(m))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    if (matches.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-gamepad"></i>
                <p>এখনো কোনো ম্যাচ নেই</p>
                <p style="font-size:12px;margin-top:8px;">অ্যাডমিন শীঘ্রই ম্যাচ তৈরি করবেন</p>
            </div>`;
        return;
    }

    const _catsForThumb = getCategories();
    let catThumb = '';
    try {
        const raw = _catsForThumb[cat] && _catsForThumb[cat].thumb;
        if (raw && String(raw).trim()) {
            const t = String(raw).trim();
            if (t.startsWith('data:') || t.startsWith('https://') || t.startsWith('http://')) catThumb = t;
            else if (typeof isUsableThumbUrl === 'function' && isUsableThumbUrl(t)) catThumb = t;
        }
    } catch (e) {}

    container.innerHTML = matches.map(m => {
        const filled = getJoinedCount(m.id);
        const total = m.maxPlayers || 48;
        const percent = Math.min(100, (filled / total) * 100);
        const isFull = filled >= total;
        const isJoined = isUserJoined(m.id);
        const startStr = formatTime(m.startTime);
        let cardThumb = '';
        if (m.thumbnail && String(m.thumbnail).trim()) {
            const mt = String(m.thumbnail).trim();
            if (mt.startsWith('data:') || mt.startsWith('https://') || mt.startsWith('http://') || (typeof isUsableThumbUrl === 'function' && isUsableThumbUrl(mt))) {
                cardThumb = mt;
            }
        }
        if (!cardThumb) cardThumb = catThumb;
        const thumbStyle = cardThumb ? 'background:none;overflow:hidden;padding:0;' : '';
        const thumbInner = cardThumb
            ? ('<img src="' + String(cardThumb).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px;display:block;" onerror="this.onerror=null;this.parentNode.innerHTML=\'<i class=\\\'fas fa-fire\\\'></i>\';">')
            : '<i class="fas fa-fire"></i>';

        const isProCard = isProLeagueCategory(m.category);
        const isPointRush = String(m.category) === 'pro-point-rush';
        // Versus Tournament = Qualified only (special card)
        const isVersus = String(m.category) === 'pro-versus';
        const tA = (m.teamALogo || '').trim();
        const tB = (m.teamBLogo || '').trim();
        const nA = (m.teamAName || 'Team A').replace(/</g, '');
        const nB = (m.teamBName || 'Team B').replace(/</g, '');
        const joinBtn = m.status === 'completed' ? '' : (isJoined
            ? `<button class="btn-join" disabled style="opacity:0.95;cursor:default;">Joined</button>`
            : (m.registrationClosed
                ? `<button class="btn-join full" disabled style="background:#636e72;font-size:11px;padding:8px 10px;">Registration Closed</button>`
                : isFull
                    ? `<button class="btn-join full" disabled>Match Full</button>`
                    : `<button class="btn-join" onclick="joinMatch(${m.id})">Join</button>`));
        const needsGroupCard = String(m.category) === 'pro-qualified';
        const groups = Array.isArray(m.groups) && m.groups.length ? m.groups : (needsGroupCard ? ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G'] : []);
        const groupStrip = needsGroupCard ? `
            <div class="pro-group-strip" onclick="event.stopPropagation()">
                ${groups.map(g => `<span class="pro-group-chip">${String(g).replace(/</g, '')}</span>`).join('')}
            </div>` : '';

        // ===== Versus Tournament card (Qualified) — user sketch =====
        if (isVersus) {
            return `
            <div class="match-card pro-match-card versus-card" onclick="openMatchDetails(${m.id})" style="cursor:pointer;">
                <div class="pro-match-time"><i class="fas fa-calendar-alt"></i> ${startStr}</div>
                <div class="pro-vs-row pro-vs-big" onclick="event.stopPropagation()">
                    <div class="pro-vs-team">
                        ${isUsableThumbUrl(tA) ? `<img src="${tA}" alt="">` : `<div class="pro-vs-ph">A</div>`}
                        <span>${nA}</span>
                    </div>
                    <div class="pro-vs-mid">VS</div>
                    <div class="pro-vs-team">
                        ${isUsableThumbUrl(tB) ? `<img src="${tB}" alt="">` : `<div class="pro-vs-ph">B</div>`}
                        <span>${nB}</span>
                    </div>
                </div>
                <div class="pro-match-title">${m.title}</div>
                <div class="versus-prize-row">
                    <div class="versus-prize-box">
                        <span class="lbl">WIN PRIZE</span>
                        <span class="val prize">${m.winPrize || 0} TK</span>
                    </div>
                    <div class="versus-prize-box">
                        <span class="lbl">ENTRY FEE</span>
                        <span class="val fee">${m.entryFee || 0} TK</span>
                    </div>
                </div>
                <div class="match-progress">
                    <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
                    <div class="progress-info">
                        <span>${isFull ? 'Only 0 spots are left' : `Only ${total - filled} spots are left`}</span>
                        <span>${filled}/${total} Joined</span>
                    </div>
                </div>
                <div class="match-actions versus-actions" onclick="event.stopPropagation()">
                    ${m.status === 'completed' ? `
                    <button class="btn-prize" onclick="showPublicMatchResult(${m.id})"><i class="fas fa-medal"></i> Result</button>
                    ` : `
                    <button class="btn-room" onclick="showRoomDetails(${m.id})"><i class="fas fa-key"></i> Room Details</button>
                    <button class="btn-prize" onclick="showPrizeDetails(${m.id})"><i class="fas fa-trophy"></i> Prize</button>
                    ${joinBtn}
                    `}
                </div>
                <div class="match-timer">
                    <i class="fas fa-clock"></i> STARTS IN - <span class="timer" data-start="${m.startTime}">${timeUntil(m.startTime)}</span>
                </div>
            </div>`;
        }

        // ===== Champion / Scrim / Point Rush — normal pro card (no forced VS) =====
        return `
        <div class="match-card" onclick="openMatchDetails(${m.id})" style="cursor:pointer;">
            ${groupStrip}
            <div class="match-card-header">
                <div class="match-thumb" style="${thumbStyle}">
                    ${thumbInner}
                </div>
                <div class="match-title-info">
                    <p style="font-size:12px;color:#8b93a7;margin:0 0 4px;">${startStr}</p>
                    <h3>${m.title}</h3>
                </div>
            </div>
            <div class="match-details">
                <div class="detail-item">
                    <div class="label">WIN PRIZE</div>
                    <div class="value prize">${m.winPrize} TK</div>
                </div>
                <div class="detail-item">
                    <div class="label">ENTRY TYPE</div>
                    <div class="value">${m.entryType}</div>
                </div>
                <div class="detail-item">
                    <div class="label">ENTRY FEE</div>
                    <div class="value fee">${m.entryFee} TK</div>
                </div>
                <div class="detail-item">
                    <div class="label">PER KILL</div>
                    <div class="value">${m.perKill} TK</div>
                </div>
                <div class="detail-item">
                    <div class="label">MAP</div>
                    <div class="value" style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;">
                        <span>${(m.maps && m.maps.length > 1) ? (m.maps.length + ' Maps') : (m.map || '—')}</span>
                        ${(m.maps && m.maps.length > 1) ? `<button type="button" class="btn-sm" style="padding:2px 8px;font-size:11px;background:#1a5cff;color:#fff;" onclick="event.stopPropagation();showMatchMaps(${m.id})">View</button>` : ''}
                    </div>
                </div>
                <div class="detail-item">
                    <div class="label">VERSION</div>
                    <div class="value">${m.version}</div>
                </div>
            </div>
            <div class="match-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${percent}%"></div>
                </div>
                <div class="progress-info">
                    <span>${isFull ? 'Only 0 spots are left' : `Only ${total - filled} spots are left`}</span>
                    <span>${filled}/${total}</span>
                </div>
            </div>
            <div class="match-actions" onclick="event.stopPropagation()">
                ${m.status === 'completed' ? `
                <button class="btn-prize" onclick="showPublicMatchResult(${m.id})">
                    <i class="fas fa-medal"></i> Result
                </button>
                ${isProCard && !isVersus ? `
                <button class="btn-room" onclick="showPointTable(${m.id})">
                    <i class="fas fa-table"></i> Point Table
                </button>` : ''}
                ` : `
                <button class="btn-room" onclick="showRoomDetails(${m.id})">
                    <i class="fas fa-key"></i> Room Details
                </button>
                <button class="btn-prize" onclick="showPrizeDetails(${m.id})">
                    <i class="fas fa-trophy"></i> Prize Details
                </button>
                ${isProCard && !isVersus ? `
                <button class="btn-room" style="background:linear-gradient(135deg,#1a5cff,#6c5ce7);" onclick="showPointTable(${m.id})">
                    <i class="fas fa-table"></i> Point Table
                </button>` : ''}
                ${joinBtn}
                `}
            </div>
            <div class="match-timer">
                <i class="fas fa-clock"></i> STARTS IN - <span class="timer" data-start="${m.startTime}">${timeUntil(m.startTime)}</span>
            </div>
        </div>`;
    }).join('');
}

function getJoinSlotCount(j) {
    if (!j) return 1;
    if (typeof j.slots === 'number' && j.slots > 0) return j.slots;
    // Pro League full squad = 4 players
    if (j.roles && (j.roles.rusher || j.roles.sniper || j.roles.bomber || j.roles.second)) return 4;
    const t = String(j.type || '').toLowerCase();
    if (t.includes('pro') || t === 'squad') return 4;
    if (t === 'duo' || j.player2) return 2;
    return 1;
}


function ordinalPrizeLabel(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getPrizeByPosition(prizes, pos, winPrize) {
    prizes = prizes || {};
    pos = Number(pos) || 0;
    if (pos < 1) return 0;
    const keys = ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'];
    let v = 0;
    if (pos <= 10 && keys[pos - 1] && prizes[keys[pos - 1]] != null) {
        v = Number(prizes[keys[pos - 1]]) || 0;
    }
    if (!v && prizes['pos' + pos] != null) v = Number(prizes['pos' + pos]) || 0;
    if (!v && prizes[String(pos)] != null) v = Number(prizes[String(pos)]) || 0;
    if (!v && pos === 1) v = Number(winPrize) || 0;
    return v;
}


function isHiddenMatchStatus(status) {
    const st = String(status || '').toLowerCase();
    return st === 'cancelled' || st === 'completed' || st === 'deleted';
}

function isActiveMatch(m) {
    if (!m) return false;
    return !isHiddenMatchStatus(m.status);
}

function collectPrizeInputs(maxN) {
    const p = {};
    const keys = ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'];
    const n = maxN || 48;
    for (let i = 1; i <= n; i++) {
        const el = document.getElementById('am-prize' + i);
        if (!el) continue;
        const val = parseInt(el.value, 10) || 0;
        p['pos' + i] = val;
        if (i <= 10) p[keys[i - 1]] = val;
    }
    return p;
}

function formatPrizeList(prizes, winPrize, limit) {
    prizes = prizes || {};
    const parts = [];
    const max = limit || 48;
    for (let i = 1; i <= max; i++) {
        const v = getPrizeByPosition(prizes, i, i === 1 ? winPrize : 0);
        if (v > 0) parts.push(ordinalPrizeLabel(i) + ': ' + v + ' TK');
    }
    if (!parts.length && winPrize) parts.push('Win Prize: ' + winPrize + ' TK');
    return parts.join(' · ');
}

function getJoinedCount(matchId) {
    return (CACHE.joins || [])
        .filter(j => String(j.matchId) === String(matchId) && !j.refunded)
        .reduce((sum, j) => sum + getJoinSlotCount(j), 0);
}

function isUserJoined(matchId) {
    if (!currentUser) return false;
    return (CACHE.joins || []).some(j =>
        String(j.matchId) === String(matchId) &&
        String(j.userId) === String(currentUser.id) &&
        !j.refunded
    );
}

let _joiningInProgress = false;
const _joinReserved = new Set(); // matchId_userId while request in flight


function joinMatch(matchId) {
    if (!currentUser) return;
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    if (!isActiveMatch(match)) return toast('এই ম্যাচ আর উপলব্ধ নেই (ডিলিট/কমপ্লিট)।');
    if (match.registrationClosed) return toast('Registration Closed — এই ম্যাচে আর জয়েন করা যাবে না');

    if (isUserJoined(matchId)) return toast('আপনি ইতিমধ্যে জয়েন করেছেন');

    const baseFee = Number(match.entryFee) || 0;
    const isProLeague = isProLeagueCategory(match.category) || (match.entryType || '').toLowerCase().includes('pro');
    const slotsNeededPreview = isProLeague ? 1 : 1;
    const filled = getJoinedCount(matchId);
    if (filled + slotsNeededPreview > (match.maxPlayers || 48)) return toast('ম্যাচ ফুল! পর্যাপ্ত স্লট নেই।');

    const matchType = (match.entryType || 'Solo').toLowerCase();
    const allowDuo = !isProLeague && (matchType.includes('duo') || matchType.includes('both') || matchType.includes('solo/duo'));
    const duoOnly = !isProLeague && matchType.includes('duo') && !matchType.includes('solo');
    let selectedType = isProLeague ? 'Squad' : (duoOnly ? 'Duo' : 'Solo');
    let currentFee = baseFee;

    // Pro League: Team Name + IGL + WhatsApp + optional logo
    const PRO_ROLES = [];

    const seriesId = match.seriesId || null;
    const seriesTotal = match.seriesTotal || 1;
    function userHasSeriesEntry() {
        if (!seriesId || !currentUser) return false;
        const seriesMatchIds = (CACHE.matches || [])
            .filter(m => String(m.seriesId) === String(seriesId))
            .map(m => String(m.id));
        return (CACHE.joins || []).some(j =>
            String(j.userId) === String(currentUser.id) && (
                String(j.seriesId || '') === String(seriesId) ||
                seriesMatchIds.includes(String(j.matchId))
            )
        );
    }
    const alreadySeriesPaid = isProLeague && !!seriesId && userHasSeriesEntry();

    function renderJoinUI() {
        const isDuo = allowDuo && selectedType === 'Duo';
        if (isProLeague && seriesId && (alreadySeriesPaid || userHasSeriesEntry())) {
            currentFee = 0;
        } else if (!isProLeague && isDuo) {
            currentFee = baseFee * 2;
        } else {
            currentFee = baseFee;
        }

        let namesHtml = '';
        if (isProLeague) {
            const isQualified = String(match.category) === 'pro-qualified';
            // Group select ONLY for Qualified Tournament
            const groups = isQualified
                ? (Array.isArray(match.groups) && match.groups.length
                    ? match.groups
                    : ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G'])
                : [];
            const groupSelect = isQualified && groups.length ? `
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-size:12px;color:#00d68f;">Group সিলেক্ট *</label>
                    <select id="join-group" style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">
                        ${groups.map(g => `<option value="${String(g).replace(/"/g, '&quot;')}">${g}</option>`).join('')}
                    </select>
                    <p style="font-size:11px;color:#8b93a7;margin:4px 0 0;">ভুল গ্রুপ হলে অ্যাডমিন পরে সরিয়ে দিতে পারবে</p>
                </div>` : '';
            namesHtml = `<p style="font-size:12px;color:#5b9dff;margin:8px 0 10px;line-height:1.5;">Pro League — টিম এন্ট্রি · ${(match.maps && match.maps.length) ? match.maps.length : seriesTotal} ম্যাপ · একবার এন্ট্রি ফি</p>
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-size:12px;color:#ffb84d;">Team Name *</label>
                    <input type="text" id="join-team-name" placeholder="আপনার টিমের নাম" maxlength="40">
                </div>
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-size:12px;color:#c5cbe0;">IGL Name *</label>
                    <input type="text" id="join-igl-name" placeholder="In-Game Leader নাম" maxlength="30">
                </div>
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-size:12px;color:#c5cbe0;">WhatsApp Number *</label>
                    <input type="tel" id="join-whatsapp" placeholder="01XXXXXXXXX" maxlength="15" inputmode="numeric">
                </div>
                ${groupSelect}
`;
        } else if (isDuo) {
            namesHtml = `
            <div class="form-group" style="margin-top:14px;">
                <input type="text" id="join-player1" placeholder="Player 1 Name" maxlength="30" style="margin-bottom:10px;">
                <input type="text" id="join-player2" placeholder="Player 2 Name" maxlength="30">
            </div>`;
        } else {
            namesHtml = `
            <div class="form-group" style="margin-top:14px;">
                <input type="text" id="join-player1" placeholder="Player 1 Name" maxlength="30">
            </div>`;
        }

        const typeButtons = isProLeague ? `
                <div style="text-align:center;margin-bottom:8px;">
                    <span style="display:inline-block;padding:8px 22px;border-radius:20px;background:linear-gradient(135deg,#e10600,#1a5cff);color:#fff;font-weight:700;font-size:13px;">Squad Mode — Pro League</span>
                </div>` : (allowDuo ? `
                <div style="display:flex;gap:10px;justify-content:center;margin-bottom:8px;">
                    <button type="button" id="btn-solo" class="btn-sm" style="padding:8px 22px;border-radius:20px;background:${!isDuo ? '#e10600' : '#333'};color:#fff;font-weight:600;">Solo</button>
                    <button type="button" id="btn-duo" class="btn-sm" style="padding:8px 22px;border-radius:20px;background:${isDuo ? '#e10600' : '#333'};color:#fff;font-weight:600;">Duo</button>
                </div>` : `
                <div style="text-align:center;margin-bottom:8px;">
                    <span style="display:inline-block;padding:8px 22px;border-radius:20px;background:#e10600;color:#fff;font-weight:600;font-size:13px;">Solo Only</span>
                </div>`);

        showModal('Join Match', `
            <div style="text-align:left;">
                <h3 style="font-size:16px;margin-bottom:4px;">${match.title}</h3>
                <p style="font-size:13px;color:#8b93a7;margin-bottom:12px;">Entry Fee: <strong style="color:#ff6b6b;">${currentFee} TK</strong>${isProLeague ? ` <span style="color:#5b9dff;">(${(match.maps && match.maps.length) ? match.maps.length : seriesTotal} Maps)</span>` : (isDuo ? ' <span style="color:#ffb84d;">(Duo = 2×)</span>' : '')} | Balance: ${formatMoney(currentUser.balance || 0)}</p>
                ${currentFee === 0 && isProLeague ? '<p style="font-size:12px;color:#00d68f;margin-bottom:8px;">সিরিজ এন্ট্রি আগে দেওয়া আছে — এই ম্যাচ ফ্রি জয়েন</p>' : ''}
                ${!isProLeague && allowDuo ? `<p style="font-size:12px;color:#8b93a7;margin:-6px 0 10px;">Solo = ${baseFee} TK · Duo = ${baseFee * 2} TK</p>` : ''}
                ${typeButtons}
                ${namesHtml}
            </div>
        `, [
            { text: 'Cancel', class: 'btn-secondary', action: closeModal },
            {
                text: 'Confirm Join', class: 'btn-primary', action: async () => {
                    // Prevent double / multi click spam
                    const reserveKey = String(matchId) + '_' + String(currentUser.id);
                    if (_joiningInProgress || _joinReserved.has(reserveKey) || isUserJoined(matchId)) {
                        toast('অপেক্ষা করুন বা ইতিমধ্যে জয়েন করেছেন');
                        return;
                    }

                    const isDuoNow = allowDuo && selectedType === 'Duo';
                    const seriesAlready = isProLeague && seriesId && userHasSeriesEntry();
                    let p1 = '', p2 = '', roles = {};
                    let inGameName = '';

                    let teamName = '';
                    let iglName = '';
                    let whatsapp = '';
                    if (isProLeague) {
                        teamName = ($('#join-team-name')?.value || '').trim();
                        iglName = ($('#join-igl-name')?.value || '').trim();
                        whatsapp = ($('#join-whatsapp')?.value || '').trim().replace(/\s+/g, '');
                        if (!teamName || teamName.length < 2) {
                            toast('টিমের নাম দিতে হবে!');
                            return;
                        }
                        if (!iglName || iglName.length < 2) {
                            toast('IGL নাম দিতে হবে!');
                            return;
                        }
                        if (!whatsapp || !/^01[3-9]\d{8}$/.test(whatsapp)) {
                            toast('সঠিক WhatsApp নম্বর দিন (01XXXXXXXXX)');
                            return;
                        }
                        p1 = iglName;
                        roles = { igl: iglName, whatsapp: whatsapp };
                        inGameName = `[${teamName}] IGL: ${iglName}`;
                        selectedType = 'Squad';
                    } else {
                        p1 = ($('#join-player1')?.value || '').trim();
                        p2 = ($('#join-player2')?.value || '').trim();
                        if (!p1 || p1.length < 2) {
                            toast('Player 1 এর নাম দিতে হবে!');
                            return;
                        }
                        if (isDuoNow && (!p2 || p2.length < 2)) {
                            toast('Player 2 এর নাম দিতে হবে!');
                            return;
                        }
                        inGameName = isDuoNow ? (p1 + ' + ' + p2) : p1;
                    }

                    // Solo = 1x, Duo = 2x entry fee; Pro series already paid = 0
                    if (seriesAlready) {
                        currentFee = 0;
                    } else if (!isProLeague && isDuoNow) {
                        currentFee = baseFee * 2;
                    } else {
                        currentFee = baseFee;
                    }
                    const slotsNeeded = isProLeague ? 1 : (isDuoNow ? 2 : 1);

                    _joiningInProgress = true;
                    _joinReserved.add(reserveKey);
                    // Disable all modal buttons immediately
                    document.querySelectorAll('#modal-footer button').forEach(b => {
                        b.disabled = true;
                        if ((b.textContent || '').includes('Confirm')) b.textContent = 'Joining...';
                    });

                    try {
                        if (isUserJoined(matchId)) {
                            toast('আপনি ইতিমধ্যে জয়েন করেছেন');
                            closeModal();
                            return;
                        }
                        if (getJoinedCount(matchId) + slotsNeeded > (match.maxPlayers || 48)) {
                            toast('ম্যাচ ফুল! ' + slotsNeeded + ' স্লট খালি নেই।');
                            return;
                        }

                        const freshUser = await cloudGetDoc('users', currentUser.id);
                        if (!freshUser) { toast('ইউজার পাওয়া যায়নি'); return; }
                        // Re-check match still joinable (not deleted mid-click)
                        const liveMatch = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
                        if (!liveMatch || !isActiveMatch(liveMatch) || liveMatch.registrationClosed) {
                            toast('এই ম্যাচে এখন জয়েন করা যাবে না');
                            closeModal();
                            return;
                        }
                        // Re-check join after network (race safe)
                        if (isUserJoined(matchId)) {
                            toast('আপনি ইতিমধ্যে জয়েন করেছেন');
                            closeModal();
                            return;
                        }
                        if ((freshUser.balance || 0) < currentFee) {
                            toast('পর্যাপ্ত ব্যালেন্স নেই! Add Money করুন।');
                            return;
                        }

                        const spent = spendFromWallet(freshUser, currentFee);
                        const newBalance = spent.balance;
                        const newWinBal = spent.winningBalance;
                        const newJoined = (freshUser.matchesJoined || 0) + 1;
                        await cloudSet('users', currentUser.id, { balance: newBalance, winningBalance: newWinBal, matchesJoined: newJoined });
                        currentUser.balance = newBalance;
                        currentUser.winningBalance = newWinBal;
                        currentUser.matchesJoined = newJoined;
                        const cu = CACHE.users.find(u => String(u.id) === String(currentUser.id));
                        if (cu) { cu.balance = newBalance; cu.winningBalance = newWinBal; cu.matchesJoined = newJoined; }

                        const mapCount = (match.maps && match.maps.length) ? match.maps.length : 1;
                        const selectedGroup = (isProLeague && String(match.category) === 'pro-qualified')
                            ? (($('#join-group')?.value || '').trim() || '')
                            : '';
                        const joinRecord = {
                            id: generateId(),
                            userId: currentUser.id,
                            matchId: matchId,
                            inGameName: inGameName,
                            teamName: isProLeague ? teamName : '',
                            iglName: isProLeague ? iglName : '',
                            whatsapp: isProLeague ? whatsapp : '',
                            teamLogo: '',
                            group: selectedGroup,
                            player1: p1,
                            player2: isDuoNow ? p2 : '',
                            roles: isProLeague ? roles : null,
                            type: selectedType,
                            slots: slotsNeeded,
                            joinedAt: new Date().toISOString(),
                            entryFee: currentFee,
                            seriesId: seriesId || null,
                            maps: match.maps || null
                        };
                        // Push to CACHE first so isUserJoined becomes true immediately
                        const alreadyJoin = (CACHE.joins || []).some(j =>
                            String(j.matchId) === String(matchId) && String(j.userId) === String(currentUser.id)
                        );
                        if (alreadyJoin) {
                            toast('আপনি ইতিমধ্যে জয়েন করেছেন');
                            closeModal();
                            return;
                        }
                        CACHE.joins.push(joinRecord);
                        await cloudSet('joins', joinRecord.id, joinRecord);
                        joinRecord._confirmed = true;

                        if (currentFee > 0) {
                            await addTransaction({
                                type: 'join',
                                amount: -currentFee,
                                status: 'approved',
                                note: isProLeague
                                    ? `Pro League entry (${mapCount} maps): ${match.title} - ${inGameName}`
                                    : `Joined: ${match.title} (${selectedType}) - ${inGameName}`
                            });
                        }

                        closeModal();
                        renderMatches(currentCategory);
                        updateProfileUI();
                        showJoinReceipt(match, joinRecord);
                    } catch (err) {
                        console.error(err);
                        toast('জয়েন ব্যর্থ — আবার চেষ্টা করুন');
                        // rollback reserve so user can retry on real failure
                        _joinReserved.delete(reserveKey);
                        // remove optimistic local join if present
                        try {
                            CACHE.joins = (CACHE.joins || []).filter(j => {
                                if (String(j.matchId) !== String(matchId)) return true;
                                if (String(j.userId) !== String(currentUser.id)) return true;
                                // drop unpaid/just-added optimistic rows without confirmed cloud write
                                return !!j._confirmed;
                            });
                        } catch (e2) {}
                    } finally {
                        _joiningInProgress = false;
                        document.querySelectorAll('#modal-footer button').forEach(b => {
                            b.disabled = false;
                            if ((b.textContent || '').includes('Joining')) b.textContent = 'Confirm Join';
                        });
                    }
                }
            }
        ]);

        setTimeout(() => {
            $('#btn-solo')?.addEventListener('click', () => {
                selectedType = 'Solo';
                renderJoinUI();
            });
            $('#btn-duo')?.addEventListener('click', () => {
                selectedType = 'Duo';
                renderJoinUI();
            });
        }, 50);
    }

    renderJoinUI();
}

function showJoinReceipt(match, joinRecord) {
    const mapText = (match.maps && match.maps.length > 1)
        ? (match.maps.length + ' Maps')
        : (match.map || '—');
    const row = (label, value, valueColor) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#9aa3b8;font-size:13px;">${label}</span>
            <strong style="color:${valueColor || '#f0f2f8'};font-size:13px;text-align:right;max-width:60%;">${value}</strong>
        </div>`;
    showModal('Join Receipt', `
        <div style="text-align:center;">
            <div style="width:60px;height:60px;background:linear-gradient(135deg,#00d68f,#1a5cff);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 15px;font-size:28px;color:white;">✓</div>
            <h3 style="color:#00d68f;margin-bottom:5px;">Join Successful!</h3>
            <p style="font-size:13px;color:#9aa3b8;margin-bottom:18px;">আপনি সফলভাবে ম্যাচে জয়েন করেছেন</p>
        </div>
        <div style="background:#0c0f18;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 16px;">
            ${row('Receipt No', '#' + String(joinRecord.id).slice(-8))}
            ${row('Player Name', joinRecord.inGameName || '—')}
            ${row('Join Type', joinRecord.type || match.entryType || 'Solo')}
            ${row('Match', match.title || '—')}
            ${row('Map', mapText)}
            ${row('Start Time', formatTime(match.startTime))}
            ${row('Entry Fee', (joinRecord.entryFee != null ? joinRecord.entryFee : match.entryFee) + ' TK', '#ff6b6b')}
            ${row('Win Prize', (match.winPrize || 0) + ' TK', '#00d68f')}
            ${row('Per Kill', (match.perKill || 0) + ' TK', '#5b9dff')}
        </div>
    `, [{ text: 'OK', class: 'btn-primary', action: closeModal }]);
}

function showMatchMaps(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return;
    const list = (match.maps && match.maps.length) ? match.maps : (match.map ? [match.map] : []);
    if (!list.length) {
        showModal('ম্যাপ', '<p style="text-align:center;color:#8b93a7;">ম্যাপ সেট করা হয়নি</p>', [
            { text: 'ঠিক আছে', class: 'btn-sm', action: closeModal }
        ]);
        return;
    }
    const rows = list.map((name, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#8b93a7;">ম্যাপ ${i + 1}</span>
            <strong style="color:#5b9dff;">${name}</strong>
        </div>
    `).join('');
    showModal('ম্যাপ লিস্ট', `
        <p style="text-align:center;font-size:13px;color:#8b93a7;margin-bottom:12px;">${match.title}</p>
        <p style="text-align:center;font-size:12px;color:#c5cbe0;margin-bottom:10px;">এক ম্যাচ · ${list.length} ম্যাপ</p>
        <div style="font-size:14px;">${rows}</div>
    `, [{ text: 'বন্ধ করুন', class: 'btn-sm', action: closeModal }]);
}


function copyRoomField(text, label) {
    const val = (text == null ? '' : String(text)).trim();
    if (!val || val === '—') {
        toast('কপি করার কিছু নেই');
        return false;
    }
    const msg = (label || 'Text') + ' কপি হয়েছে!';
    function done() {
        try { toast(msg); } catch (e) {}
        try {
            const btn = (typeof event !== 'undefined' && event && event.target)
                ? (event.target.closest('button') || event.target)
                : null;
            if (btn && btn.tagName === 'BUTTON') {
                const prev = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                setTimeout(function () { try { btn.innerHTML = prev; } catch (e2) {} }, 1500);
            }
        } catch (e3) {}
    }
    function fallbackCopy() {
        const ta = document.createElement('textarea');
        ta.value = val;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, val.length);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }
    try {
        if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(val).then(function () { done(); }).catch(function () {
                if (fallbackCopy()) done();
                else toast(val);
            });
            return true;
        }
    } catch (e0) {}
    if (fallbackCopy()) done();
    else toast(val);
    return true;
}

function showRoomDetails(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return;
    const joined = isUserJoined(matchId);
    // Joined players + Admin can see; normal users only after join
    if (!joined && !currentUser?.isAdmin) {
        showModal('রুম ডিটেইলস', `<p style="text-align:center;color:#8b93a7;line-height:1.6;">ম্যাচে জয়েন করার পর রুম আইডি ও পাসওয়ার্ড দেখতে পাবেন।</p>`, [
            { text: 'ঠিক আছে', class: 'btn-sm', action: closeModal }
        ]);
        return;
    }
    const hasRoom = !!(match.roomId || match.roomPass);
    if (!hasRoom) {
        showModal('Room Details', `
            <div style="text-align:center;padding:8px 4px;">
                <p style="font-size:13px;color:#8b93a7;margin-bottom:10px;">${match.title}</p>
                <div style="background:rgba(26,92,255,0.12);border:1px solid rgba(26,92,255,0.28);padding:16px 14px;border-radius:12px;text-align:left;">
                    <p style="font-size:14px;line-height:1.7;color:#e8ecf8;margin:0;">
                        <i class="fas fa-info-circle" style="color:#5b9dff;"></i>
                        ম্যাচ শুরু হওয়ার <strong style="color:#5b9dff;">২ থেকে ৪ মিনিট</strong> আগে রুম ডিটেইলস পাবেন
                    </p>
                </div>
            </div>
        `, [
            { text: 'Refresh', class: 'btn-sm', action: () => { closeModal(); setTimeout(() => showRoomDetails(matchId), 200); } },
            { text: 'Close', class: 'btn-sm', action: closeModal }
        ]);
        return;
    }
    const rid = match.roomId != null ? String(match.roomId) : '';
    const rpass = match.roomPass != null ? String(match.roomPass) : '';
    const rnote = String(match.roomNote || match.roomNotice || '').trim();
    const noteHtml = rnote ? `
            <div style="background:rgba(255,184,77,0.12);padding:14px 16px;border-radius:12px;border:1px solid rgba(255,184,77,0.35);margin-top:10px;text-align:left;">
                <div style="font-size:11px;color:#ffb84d;font-weight:700;margin-bottom:6px;letter-spacing:0.3px;">📌 Notice</div>
                <div style="font-size:14px;line-height:1.55;color:#f0e6d0;white-space:pre-wrap;">${rnote.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            </div>` : '';
    showModal('Room Details', `
        <div style="text-align:center;padding:10px 0;">
            <p style="font-size:13px;color:#8b93a7;margin-bottom:12px;">${match.title}</p>
            <div style="background:rgba(26,92,255,0.15);padding:16px;border-radius:12px;margin-bottom:10px;border:1px solid rgba(26,92,255,0.3);">
                <div style="font-size:12px;color:#8b93a7;margin-bottom:4px;">Room ID</div>
                <div style="font-size:22px;font-weight:800;color:#5b9dff;letter-spacing:1px;margin-bottom:10px;">${rid || '—'}</div>
                <button type="button" class="btn-sm copy-room-btn" data-copy="${String(rid).replace(/"/g, '&quot;')}" data-label="Room ID"
                    style="background:#1a5cff;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer;">
                    <i class="fas fa-copy"></i> Copy Room ID
                </button>
            </div>
            <div style="background:rgba(225,6,0,0.12);padding:16px;border-radius:12px;border:1px solid rgba(225,6,0,0.3);">
                <div style="font-size:12px;color:#8b93a7;margin-bottom:4px;">Password</div>
                <div style="font-size:22px;font-weight:800;color:#ff6b6b;letter-spacing:1px;margin-bottom:10px;">${rpass || '—'}</div>
                <button type="button" class="btn-sm copy-room-btn" data-copy="${String(rpass).replace(/"/g, '&quot;')}" data-label="Password"
                    style="background:#e10600;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer;">
                    <i class="fas fa-copy"></i> Copy Password
                </button>
            </div>
            ${noteHtml}
            <p style="font-size:12px;color:#8b93a7;margin-top:12px;">Happy Gaming!</p>
        </div>
    `, [{ text: 'Close', class: 'btn-sm', action: closeModal }]);
    // Bind copy buttons (avoids broken inline onclick quotes)
    setTimeout(function () {
        document.querySelectorAll('#modal-body .copy-room-btn').forEach(function (btn) {
            btn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                copyRoomField(btn.getAttribute('data-copy') || '', btn.getAttribute('data-label') || 'Text');
            };
        });
    }, 30);
}

function openMatchDetails(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return;
    currentMatchId = matchId;
    const page = $('#match-detail-page');
    if (!page) {
        // fallback modal
        showRoomDetails(matchId);
        return;
    }
    const cats = getCategories();
    const catKey = match.category || '';
    const catName = cats[catKey]?.name || cats[catKey]?.title || catKey || 'Match';
    const modeRules = CACHE.modeRules || {};
    let rulesHtml = modeRules[catKey] || '';
    if (!rulesHtml || !String(rulesHtml).trim()) {
        rulesHtml = '<p style="color:#8b93a7;text-align:center;padding:12px 0;">এই মোডের রুলস এখনো সেট করা হয়নি। অ্যাডমিন → Rules থেকে সেট করুন।</p>';
    } else {
        rulesHtml = formatRulesHtml(rulesHtml);
    }
    const mapText = (match.maps && match.maps.length > 1)
        ? (match.maps.length + ' Maps · ' + match.maps.join(', '))
        : (match.map || '—');
    const settings = CACHE.settings || {};
    const showPlayers = settings.showJoinedPlayers !== false;
    const joins = (CACHE.joins || []).filter(j => String(j.matchId) === String(matchId));
    // Prize chips (up to 48)
    const p = match.prizes || {};
    let prizeChips = '';
    for (let i = 1; i <= 48; i++) {
        const val = getPrizeByPosition(p, i, match.winPrize);
        if (val > 0) prizeChips += `<span style="display:inline-block;padding:6px 12px;margin:4px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);font-size:12px;">${ordinalPrizeLabel(i)}: <strong style="color:#ff6b6b;">${val} TK</strong></span>`;
    }
    if (Number(match.perKill) > 0) {
        prizeChips += `<span style="display:inline-block;padding:6px 12px;margin:4px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);font-size:12px;">Per Kill: <strong style="color:#00d68f;">${match.perKill} TK</strong></span>`;
    }
    if (!prizeChips) prizeChips = `<span style="color:#8b93a7;font-size:13px;">Win Prize: ${match.winPrize || 0} TK</span>`;

    let playersHtml = '';
    const isPointRushDetail = String(match.category) === 'pro-point-rush';
    const isQualifiedDetail = String(match.category) === 'pro-qualified';
    const isVersusDetail = String(match.category) === 'pro-versus';
    if (!showPlayers) {
        playersHtml = '<p style="text-align:center;color:#8b93a7;padding:16px 0;">প্লেয়ার লিস্ট অ্যাডমিন বন্ধ রেখেছে</p>';
    } else if (!joins.length) {
        playersHtml = '<p style="text-align:center;color:#8b93a7;padding:16px 0;">এখনো কেউ জয়েন করেনি</p>';
    } else if (isQualifiedDetail) {
        const groupOrder = Array.isArray(match.groups) && match.groups.length
            ? match.groups.slice()
            : ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G'];
        const byG = {};
        joins.forEach(j => {
            const g = j.group || 'Ungrouped';
            if (!byG[g]) byG[g] = [];
            byG[g].push(j);
        });
        const orderedKeys = groupOrder.filter(g => byG[g] && byG[g].length);
        Object.keys(byG).forEach(g => { if (!orderedKeys.includes(g)) orderedKeys.push(g); });
        playersHtml = orderedKeys.map(g => {
            const list = byG[g] || [];
            const rows = list.map((j, i) => {
                let name = j.teamName || j.inGameName || j.player1 || '—';
                if (j.iglName) name += ' · IGL: ' + j.iglName;
                if (currentUser && currentUser.isAdmin && j.whatsapp) name += ' · WA: ' + j.whatsapp;
                return `<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <span style="min-width:24px;color:#5b9dff;font-weight:700;">${i + 1}</span>
                    <div style="flex:1;color:#f0f2f8;font-size:14px;word-break:break-word;">${name}</div>
                </div>`;
            }).join('');
            return `<div style="margin-bottom:14px;">
                <div style="font-weight:800;color:#fdcb6e;font-size:14px;margin:8px 0 4px;padding:8px 10px;border-radius:10px;background:rgba(253,203,110,0.12);border:1px solid rgba(253,203,110,0.25);">${g} · ${list.length} team</div>
                ${rows}
            </div>`;
        }).join('');
    } else {
        playersHtml = joins.map((j, i) => {
            let name = j.inGameName || j.player1 || '—';
            if (j.teamName) {
                name = j.teamName + ((j.iglName || j.player1) ? (' · IGL: ' + (j.iglName || j.player1)) : '');
                if (currentUser && currentUser.isAdmin && (j.whatsapp || (j.roles && j.roles.whatsapp))) {
                    name += ' · WA: ' + (j.whatsapp || j.roles.whatsapp);
                }
            } else if (j.roles) {
                const r = j.roles;
                if (r.igl) {
                    name = (j.teamName ? j.teamName + ' · ' : '') + 'IGL: ' + r.igl;
                    if (currentUser && currentUser.isAdmin && r.whatsapp) name += ' · WA: ' + r.whatsapp;
                } else name = [r.rusher, r.second, r.bomber, r.sniper].filter(Boolean).join(' · ') || name;
            } else if (j.player2) {
                name = (j.player1 || '') + ' + ' + j.player2;
            }
            return `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                <span style="min-width:28px;color:#5b9dff;font-weight:700;">${i + 1}</span>
                <div style="flex:1;">
                    <div style="color:#f0f2f8;font-size:14px;word-break:break-word;">${name}</div>
                    <div style="font-size:11px;color:#8b93a7;margin-top:3px;">${j.type || match.entryType || 'Solo'}${j.entryFee != null ? ' · ' + j.entryFee + ' TK' : ''}</div>
                </div>
            </div>`;
        }).join('');
    }

    // Qualified: big Team vs Team banner for detail page
    let qualifiedVsBanner = '';
    if (isVersusDetail || String(match.category) === 'pro-versus') {
        const tA = (match.teamALogo || '').trim();
        const tB = (match.teamBLogo || '').trim();
        const nA = (match.teamAName || 'Team A').replace(/</g, '');
        const nB = (match.teamBName || 'Team B').replace(/</g, '');
        qualifiedVsBanner = `
            <div class="pro-vs-row pro-vs-big" style="margin:12px 0 16px;">
                <div class="pro-vs-team">
                    ${isUsableThumbUrl(tA) ? `<img src="${tA}" alt="">` : `<div class="pro-vs-ph">A</div>`}
                    <span>${nA}</span>
                </div>
                <div class="pro-vs-mid">VS</div>
                <div class="pro-vs-team">
                    ${isUsableThumbUrl(tB) ? `<img src="${tB}" alt="">` : `<div class="pro-vs-ph">B</div>`}
                    <span>${nB}</span>
                </div>
            </div>`;
    }

    const hasRoom = !!(match.roomId && String(match.roomId).trim());
    const canSeeRoom = isUserJoined(matchId) || !!(currentUser && currentUser.isAdmin);
    let roomBanner;
    if (!canSeeRoom) {
        roomBanner = `<div style="background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.35);color:#ffb84d;padding:12px;border-radius:10px;font-size:13px;margin:12px 0;">
            জয়েন করার পর রুম আইডি ও পাসওয়ার্ড দেখতে পাবেন।
           </div>`;
    } else if (hasRoom) {
        const noteLine = String(match.roomNote || match.roomNotice || '').trim();
        roomBanner = `<div style="background:rgba(0,214,143,0.12);border:1px solid rgba(0,214,143,0.35);color:#00d68f;padding:12px;border-radius:10px;font-size:13px;margin:12px 0;">
            <strong>Room ID:</strong> ${match.roomId}<br>
            <strong>Password:</strong> ${match.roomPass || '—'}
            ${noteLine ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,184,77,0.35);color:#ffb84d;"><strong>📌 Notice:</strong> ${noteLine.replace(/</g,'&lt;')}</div>` : ''}
           </div>`;
    } else {
        roomBanner = `<div style="background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.35);color:#ffb84d;padding:12px;border-radius:10px;font-size:13px;margin:12px 0;">
            ম্যাচ শুরুর ৪–৫ মিনিট আগে রুম আইডি ও পাসওয়ার্ড দেওয়া হবে।
           </div>`;
    }

    page.innerHTML = `
        <div class="page-header" style="position:sticky;top:0;z-index:5;background:var(--bg,#0a0c12);">
            <button class="back-btn" type="button" onclick="closeMatchDetails()"><i class="fas fa-arrow-left"></i></button>
            <div class="page-header-text"><h2>Details</h2></div>
            <button class="back-btn" type="button" onclick="openMatchDetails(${matchId})" title="Refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
        <div style="padding:12px 16px 100px;overflow-y:auto;">
            <h3 style="font-size:18px;color:#f0f2f8;margin-bottom:10px;">${match.title || catName}</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
                <span style="padding:6px 12px;border-radius:20px;background:rgba(26,92,255,0.2);color:#7eb0ff;font-size:12px;">Type: ${match.entryType || 'Solo'}</span>
                <span style="padding:6px 12px;border-radius:20px;background:rgba(255,255,255,0.06);color:#c5cbe0;font-size:12px;">Map: ${mapText}</span>
                <span style="padding:6px 12px;border-radius:20px;background:rgba(255,255,255,0.06);color:#c5cbe0;font-size:12px;">${match.version || 'Mobile'}</span>
                <span style="padding:6px 12px;border-radius:20px;background:rgba(225,6,0,0.2);color:#ff6b6b;font-size:12px;">Entry: ${match.entryFee || 0} TK</span>
            </div>
            <p style="font-size:13px;color:#8b93a7;margin-bottom:8px;">Schedule: <strong style="color:#e8ecf8;">${formatTime(match.startTime)}</strong></p>

            <h4 style="font-size:15px;color:#f0f2f8;margin:18px 0 10px;">Prize Details</h4>
            <div>${prizeChips}</div>

            ${qualifiedVsBanner}${roomBanner}

            <h4 style="font-size:15px;color:#f0f2f8;margin:18px 0 10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">Match Instructions and Rules</h4>
            <div class="rules-content" style="font-size:13px;line-height:1.85;color:#c5cbe0;white-space:normal;word-break:break-word;">
                ${rulesHtml}
            </div>

            <h4 style="font-size:15px;color:#f0f2f8;margin:22px 0 10px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);">
                Registered Participants (${showPlayers ? joins.length : '—'})
            </h4>
            <div>${playersHtml}</div>
        </div>
    `;
    navigateTo('match-detail', { instant: true });
    // Admin disabled player list → popup like reference app
    if (!showPlayers) {
        setTimeout(() => {
            showErrorPopup(
                'Participants List',
                'এই ম্যাচের প্লেয়ার লিস্ট দেখার অপশন এডমিন বন্ধ করে দিয়েছে।',
                'Please try again'
            );
        }, 120);
    }
}

function closeMatchDetails() {
    if (appNavStack.length > 1) {
        handleAppBack();
        return;
    }
    if (currentCategory && isProLeagueCategory(currentCategory)) navigateTo('pro-league');
    else if (currentCategory) navigateTo('match-list', { instant: true });
    else navigateTo('play');
}


function showPrizeDetails(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return;
    const p = match.prizes || {};
    const rows = [];
    // Total winning prize (card-এর WIN PRIZE)
    const totalWin = Number(match.winPrize) || 0;
    if (totalWin > 0) {
        rows.push(`<div style="display:flex;justify-content:space-between;padding:12px 0;margin-bottom:6px;border-bottom:2px solid rgba(255,107,107,0.35);"><span style="font-weight:700;color:#ffb84d;">🏆 Total Winning Prize</span><strong style="color:#ff6b6b;font-size:16px;">${totalWin} TK</strong></div>`);
    }
    for (let i = 1; i <= 48; i++) {
        // position prizes — don't double-count winPrize as 1st if separate position set
        let val = getPrizeByPosition(p, i, 0);
        if (i === 1 && !val && !(p.first || p.pos1)) {
            // only show 1st from list if explicitly set; total already shown above
            val = 0;
        }
        if (val > 0) {
            const icon = i === 1 ? '🥇 ' : (i === 2 ? '🥈 ' : (i === 3 ? '🥉 ' : ''));
            rows.push(`<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);"><span>${icon}${i}ম প্রাইজ</span><strong style="color:#e8ecf8;">${val} TK</strong></div>`);
        }
    }
    const perKill = Number(match.perKill) || 0;
    if (perKill > 0) rows.push(`<div style="display:flex;justify-content:space-between;padding:10px 0;margin-top:6px;"><span>Per Kill</span><strong style="color:#00d68f;">${perKill} TK</strong></div>`);
    if (rows.length <= (totalWin > 0 ? 1 : 0) && perKill <= 0) {
        rows.push(`<p style="text-align:center;color:#8b93a7;padding:12px 0;">পজিশন প্রাইজ সেট নেই</p>`);
    }
    const pNote = String(match.prizeNote || match.prizeNotice || '').trim();
    const pNoteBlock = pNote
        ? `<div style="margin-top:12px;padding:12px 14px;border-radius:12px;background:rgba(255,184,77,0.12);border:1px solid rgba(255,184,77,0.35);text-align:left;">
            <div style="font-size:11px;color:#ffb84d;font-weight:700;margin-bottom:6px;">📌 Prize Notice</div>
            <div style="font-size:14px;line-height:1.55;color:#f0e6d0;white-space:pre-wrap;">${pNote.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
           </div>`
        : '';
    showModal('প্রাইজ ডিটেইলস', `<div style="font-size:14px;max-height:60vh;overflow-y:auto;">${rows.join('')}${pNoteBlock}</div>`, [
        { text: 'বন্ধ করুন', class: 'btn-sm', action: closeModal }
    ]);
}


// ==================== ERROR POPUP (Deposit / Withdraw mistakes) ====================
function showErrorPopup(title, message, subMessage) {
    const titleText = title || 'Dear User';
    const msg = message || 'Please try again';
    const sub = subMessage || '';
    showModal(titleText, `
        <div class="error-popup-body">
            <div class="error-popup-icon"><i class="fas fa-times"></i></div>
            <p class="error-popup-please">Please try again</p>
            <div class="error-popup-box">
                <i class="fas fa-info-circle"></i>
                <span>${msg}</span>
            </div>
            ${sub && sub !== msg ? `<p class="error-popup-sub">${sub}</p>` : ''}
        </div>
    `, [
        { text: 'Retry', class: 'btn-secondary', action: closeModal },
        { text: 'OK', class: 'btn-primary', action: closeModal }
    ]);
}

let currentTxHistoryTab = 'deposit';
let adminMatchesCatFilter = 'all';
let adminResultCatFilter = 'all';

function txMatchesTab(t, tab) {
    const type = String(t.type || '').toLowerCase();
    const note = String(t.note || '').toLowerCase();
    if (tab === 'deposit') {
        return type === 'deposit' || note.includes('add money') || note.includes('deposit');
    }
    if (tab === 'join') {
        return type === 'join' || type === 'refund' || note.includes('joined') || note.includes('entry') || note.includes('pro league entry');
    }
    if (tab === 'withdraw') {
        return type === 'withdraw';
    }
    if (tab === 'balance') {
        return type === 'admin_credit' || type === 'admin_debit' || note.includes('balance') || note.includes('admin');
    }
    if (tab === 'reward') {
        return type === 'prize' || type === 'leaderboard' || note.includes('prize') || note.includes('reward') || note.includes('leaderboard');
    }
    return false;
}

function formatTxStatusLabel(t) {
    const s = String(t.status || '').toLowerCase();
    const type = String(t.type || '').toLowerCase();
    if (s === 'pending') return 'Pending';
    if (s === 'rejected') return 'Rejected';
    if (type === 'refund' || s === 'refunded') return 'Refunded';
    if (type === 'join' || (t.amount != null && Number(t.amount) < 0 && type !== 'withdraw')) return 'Debited';
    if (s === 'approved' || type === 'prize' || type === 'deposit' || type === 'admin_credit') return 'Credited';
    if (Number(t.amount) >= 0) return 'Credited';
    return 'Debited';
}

function loadTxHistory(tab) {
    if (tab) currentTxHistoryTab = tab;
    const tabs = document.querySelectorAll('#tx-history-tabs .tx-tab');
    tabs.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.txTab === currentTxHistoryTab);
    });
    const list = document.getElementById('tx-history-list');
    if (!list || !currentUser) return;

    const txs = dedupeById(CACHE.transactions || [])
        .filter(t => String(t.userId) === String(currentUser.id))
        .filter(t => txMatchesTab(t, currentTxHistoryTab))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (!txs.length) {
        list.innerHTML = `
            <div class="empty-state tx-empty">
                <i class="fas fa-receipt"></i>
                <p>No Transaction Found</p>
            </div>`;
        return;
    }

    list.innerHTML = txs.map((t, i) => {
        const amt = Number(t.amount) || 0;
        const positive = amt >= 0;
        const statusLabel = formatTxStatusLabel(t);
        const title = (t.note || t.type || 'Transaction').toString();
        const shortTitle = title.length > 42 ? title.slice(0, 40) + '…' : title;
        const meta = [];
        if (t.trxId) meta.push('TxnID: ' + t.trxId);
        if (t.method) meta.push(t.method);
        if (t.matchId) meta.push('Match: ' + String(t.matchId).slice(0, 8));
        const idx = String(i + 1).padStart(2, '0');
        return `
        <div class="tx-card">
            <div class="tx-card-left">
                <div class="tx-badge ${positive ? 'in' : 'out'}">
                    <i class="fas fa-arrow-${positive ? 'down' : 'up'}"></i>
                </div>
                <div class="tx-card-info">
                    <h4>${escapeHtml(shortTitle)} <span class="tx-idx">#${idx}</span></h4>
                    ${meta.length ? `<p class="tx-meta">${escapeHtml(meta.join(' · '))}</p>` : ''}
                    <p class="tx-time">${formatTime(t.createdAt)}</p>
                </div>
            </div>
            <div class="tx-card-right">
                <div class="tx-amt ${positive ? 'plus' : 'minus'}">${positive ? '+' : ''}${amt} ৳</div>
                <div class="tx-st ${statusLabel.toLowerCase()}">${statusLabel}</div>
            </div>
        </div>`;
    }).join('');
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ==================== WALLET ====================
async function addTransaction(tx) {
    const uid = tx.userId != null ? tx.userId : (currentUser && currentUser.id);
    const fingerprint = [
        'tx',
        tx.type || '',
        String(uid || ''),
        String(tx.amount ?? ''),
        String(tx.trxId || ''),
        String(tx.number || ''),
        String(tx.note || ''),
        String(tx.matchId || '')
    ].join('|');
    if (!claimRequest(fingerprint, 4000)) {
        console.warn('Blocked duplicate transaction:', fingerprint);
        return null;
    }
    const record = {
        id: generateId(),
        userId: uid,
        ...tx,
        userId: uid,
        createdAt: new Date().toISOString()
    };
    await cloudSet('transactions', record.id, record);
    cachePushUnique('transactions', record);
    return record;
}

async function loadWallet() {
    const fresh = await cloudGetDoc('users', currentUser.id);
    if (fresh) {
        currentUser = fresh;
        const cu = CACHE.users.find(u => String(u.id) === String(currentUser.id));
        if (cu) Object.assign(cu, fresh);
    }
    const bal = Number(currentUser.balance) || 0;
    const win = getWinningBalance(currentUser);
    const deposited = Math.max(0, bal - win);
    const balEl = $('#wallet-balance');
    if (balEl) balEl.textContent = '৳ ' + bal;
    updateNavBalance();
    const depEl = $('#wallet-deposited');
    if (depEl) depEl.textContent = '৳ ' + deposited;
    const winEl = $('#wallet-winning');
    if (winEl) winEl.textContent = '৳ ' + win;

    // Learn & Support YouTube links from admin settings
    const s = CACHE.settings || {};
    const links = {
        'learn-add-money': s.tutorialAddMoney || '',
        'learn-join-match': s.tutorialJoinMatch || '',
        'learn-join-room': s.tutorialJoinRoom || ''
    };
    Object.keys(links).forEach(id => {
        const a = document.getElementById(id);
        if (!a) return;
        const url = (links[id] || '').trim();
        if (url) {
            a.href = url;
            a.onclick = null;
            a.target = '_blank';
            a.style.opacity = '1';
        } else {
            a.href = '#';
            a.target = '_self';
            a.onclick = (e) => { e.preventDefault(); toast('টিউটোরিয়াল লিংক এখনো সেট হয়নি'); };
            a.style.opacity = '0.75';
        }
    });
}

function clearWithdrawForm() {
    try {
        const amt = document.getElementById('withdraw-amount');
        const num = document.getElementById('withdraw-number');
        if (amt) amt.value = '';
        if (num) num.value = '';
        const radios = document.querySelectorAll('input[name="withdraw-method"]');
        radios.forEach((r, i) => { r.checked = (i === 0); });
    } catch (e) {}
}

function clearDepositForm() {
    try {
        const trx = document.getElementById('deposit-trx');
        if (trx) trx.value = '';
    } catch (e) {}
}

function getPaymentInfo(method) {
    const settings = CACHE.settings || {};
    return (settings.payments || {})[method] || { number: '01700000000', type: 'Personal' };
}

function renderDepositInstructions(method) {
    currentDepositMethod = method;
    const p = getPaymentInfo(method);
    const box = $('#deposit-method-box');
    const instr = $('#deposit-instructions');
    if (!box || !instr) return;
    box.className = 'deposit-box ' + method.toLowerCase() + '-box';
    const guides = {
        bKash: [
            '*247# ডায়াল করে আপনার BKASH মোবাইল মেনুতে যান অথবা BKASH অ্যাপে যান।',
            'Send Money / Make Payment - এ ক্লিক করুন।',
            'প্রাপক নম্বর হিসেবে নিচের নম্বরটি লিখুন।',
            'নিশ্চিত করে এখন আপনার BKASH মোবাইল পিন লিখুন।',
            'এখন উপরের বক্সে আপনার Transaction ID এবং Amount দিন আর নিচের VERIFY বাটনে ক্লিক করুন।'
        ],
        Nagad: [
            '*167# ডায়াল করে আপনার NAGAD মোবাইল মেনুতে যান অথবা NAGAD অ্যাপে যান।',
            'Send Money - এ ক্লিক করুন।',
            'প্রাপক নম্বর হিসেবে নিচের নম্বরটি লিখুন।',
            'নিশ্চিত করে এখন আপনার Nagad মোবাইল পিন লিখুন।',
            'এখন উপরের বক্সে আপনার Transaction ID এবং Amount দিন আর নিচের VERIFY বাটনে ক্লিক করুন।'
        ]
    };
    const steps = guides[method] || guides.bKash;
    instr.innerHTML = `
        <ol>${steps.map(s => '<li>' + s + '</li>').join('')}</ol>
        <div class="pay-number-row">
            <span class="pay-number">${p.number}</span>
            <button type="button" class="btn-copy" onclick="copyPayNumber()">Copy</button>
        </div>
        <p style="font-size:12px;margin-top:6px;opacity:0.9;">Type: ${p.type || 'Personal'}</p>
    `;
}

function copyPayNumber() {
    const p = getPaymentInfo(currentDepositMethod);
    if (navigator.clipboard) {
        navigator.clipboard.writeText(p.number).then(() => toast('নম্বর কপি হয়েছে!')).catch(() => toast(p.number));
    } else {
        toast(p.number);
    }
}
window.copyPayNumber = copyPayNumber;

let _depositSubmitting = false;
let _withdrawSubmitting = false;

async function submitDeposit() {
    if (_depositSubmitting) return toast('অপেক্ষা করুন...');
    const method = currentDepositMethod || 'bKash';
    const trx = ($('#deposit-trx')?.value || '').trim();

    if (!trx || trx.length < 5) {
        return showErrorPopup('Dear User', 'সঠিক Transaction ID দিন', 'Please enter a valid Transaction ID');
    }

    // Same TRX already used by anyone (pending or approved)
    const dupTrx = (CACHE.transactions || []).some(t =>
        t.type === 'deposit' &&
        String(t.trxId || '').toLowerCase() === trx.toLowerCase() &&
        (t.status === 'pending' || t.status === 'approved')
    );
    if (dupTrx) {
        return showErrorPopup('Dear User', 'এই ট্রানজেকশনটি ইতিমধ্যে ব্যবহৃত', 'This transaction ID is already used');
    }

    _depositSubmitting = true;
    const depBtn = document.querySelector('#btn-submit-deposit, #submit-deposit, button[onclick*="submitDeposit"]');
    if (depBtn) { depBtn.disabled = true; depBtn.textContent = 'Submitting...'; }

    try {
        // Amount is 0 until admin sets it from real TRX
        await addTransaction({
            type: 'deposit',
            amount: 0,
            status: 'pending',
            method,
            trxId: trx,
            note: `Add Money via ${method} (amount set by admin)`
        });

        toast('Add Money রিকোয়েস্ট পাঠানো হয়েছে! অ্যাডমিন ট্রানজেকশন দেখে কনফার্ম করবেন।');
        if ($('#deposit-trx')) $('#deposit-trx').value = '';
        navigateTo('wallet');
    } catch (e) {
        console.error(e);
        showErrorPopup('Dear User', 'রিকোয়েস্ট ব্যর্থ — আবার চেষ্টা করুন', 'Please try again');
    } finally {
        _depositSubmitting = false;
        if (depBtn) { depBtn.disabled = false; depBtn.textContent = 'VERIFY'; }
    }
}

async function submitWithdraw() {
    if (_withdrawSubmitting) return toast('অপেক্ষা করুন...');
    const method = document.querySelector('input[name="withdraw-method"]:checked')?.value;
    const amount = parseInt($('#withdraw-amount').value);
    const number = $('#withdraw-number').value.trim();

    if (!amount || amount < 105) return showErrorPopup('Dear User', 'মিনিমাম উইথড্র ১০৫ টাকা।', 'Minimum withdraw 105 TK');
    if (!method) return showErrorPopup('Dear User', 'Please select a payment method', 'পেমেন্ট মেথড সিলেক্ট করুন');
    if (!number || !/^01[3-9]\d{8}$/.test(number)) return showErrorPopup('Dear User', 'সঠিক মোবাইল নম্বর দিন', 'Please enter a valid mobile number');

    // Already have a pending withdraw?
    const hasPending = (CACHE.transactions || []).some(t =>
        t.type === 'withdraw' &&
        String(t.userId) === String(currentUser.id) &&
        t.status === 'pending'
    );
    if (hasPending) return showErrorPopup('Dear User', 'একটি উইথড্র রিকোয়েস্ট ইতিমধ্যে পেন্ডিং আছে', 'You already have a pending withdraw');

    _withdrawSubmitting = true;
    const wdBtn = document.querySelector('#btn-submit-withdraw, button[onclick*="submitWithdraw"]');
    if (wdBtn) { wdBtn.disabled = true; wdBtn.textContent = 'Submitting...'; }

    try {
        const fresh = await cloudGetDoc('users', currentUser.id);
        if (!fresh) { showErrorPopup('Dear User', 'ইউজার পাওয়া যায়নি', 'Please try again'); return; }
        const winBal = getWinningBalance(fresh);
        if (amount > winBal) {
            showErrorPopup('Dear User', 'Insufficient funds. Available balance: ' + winBal, 'শুধু উইনিং প্রাইজ উইথড্র করা যাবে। উইথড্রেবল: ' + winBal + ' TK');
            return;
        }
        if (amount > (fresh.balance || 0)) {
            showErrorPopup('Dear User', 'Insufficient funds. Available balance: ' + (fresh.balance || 0), 'পর্যাপ্ত ব্যালেন্স নেই');
            return;
        }

        // Hold from total + winning
        const newBal = (fresh.balance || 0) - amount;
        const newWin = winBal - amount;
        await cloudSet('users', currentUser.id, { balance: newBal, winningBalance: newWin });
        currentUser.balance = newBal;
        currentUser.winningBalance = newWin;
        const cu = CACHE.users.find(u => String(u.id) === String(currentUser.id));
        if (cu) { cu.balance = newBal; cu.winningBalance = newWin; }

        await addTransaction({
            type: 'withdraw',
            amount: -amount,
            status: 'pending',
            method,
            number,
            note: `Withdraw to ${method} ${number}`
        });

        toast('উইথড্র রিকোয়েস্ট পাঠানো হয়েছে!');
        $('#withdraw-amount').value = '';
        $('#withdraw-number').value = '';
        navigateTo('wallet');
    } catch (e) {
        console.error(e);
        showErrorPopup('Dear User', 'Please try again', 'রিকোয়েস্ট ব্যর্থ — আবার চেষ্টা করুন');
    } finally {
        _withdrawSubmitting = false;
        if (wdBtn) { wdBtn.disabled = false; wdBtn.textContent = 'Submit Withdraw'; }
    }
}

// ==================== MY MATCHES & RESULTS ====================

function showPointTable(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    const img = (match.pointTableImage || '').trim();
    if (img) {
        showModal('Point Table', `
            <div style="text-align:center;">
                <img src="${img}" alt="Point Table" style="width:100%;max-height:70vh;object-fit:contain;border-radius:12px;">
            </div>
        `, [{ text: 'Close', class: 'btn-sm', action: closeModal }]);
    } else {
        showModal('Point Table', `
            <div style="text-align:center;padding:18px 10px;">
                <i class="fas fa-hourglass-half" style="font-size:36px;color:#5b9dff;margin-bottom:12px;"></i>
                <p style="font-size:15px;color:#e8ecf8;line-height:1.7;margin:0;">
                    ম্যাচ শেষ হওয়ার কিছুক্ষণ পর পয়েন্ট টেবিল দেওয়া হবে।<br>
                    <strong style="color:#ffb84d;">দয়া করে অপেক্ষা করুন।</strong>
                </p>
            </div>
        `, [{ text: 'OK', class: 'btn-primary', action: closeModal }]);
    }
}

function showPublicMatchResult(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    const joins = (CACHE.joins || []).filter(j =>
        String(j.matchId) === String(matchId) && !j.refunded && (j.prizePaid || j.position || j.kills)
    ).sort((a, b) => {
        const pa = Number(a.position) || 999;
        const pb = Number(b.position) || 999;
        if (pa !== pb) return pa - pb;
        return (Number(b.kills) || 0) - (Number(a.kills) || 0);
    });
    const perKill = Number(match.perKill) || 0;
    const prizes = match.prizes || {};
    let prizeInfo = formatPrizeList(prizes, match.winPrize, 48);
    if (!prizeInfo) prizeInfo = 'Win Prize: ' + (match.winPrize || 0) + ' TK';

    let body = `
        <p style="font-size:13px;color:#c5cbe0;margin-bottom:6px;"><strong>${match.title}</strong></p>
        <p style="font-size:12px;color:#8b93a7;margin-bottom:12px;line-height:1.5;">
            Per Kill: <strong style="color:#00d68f;">${perKill} TK</strong><br>${prizeInfo}
            ${match.winner ? '<br>Winner: <strong style="color:#ffb84d;">' + match.winner + '</strong>' : ''}
        </p>`;

    if (!joins.length) {
        body += '<p style="text-align:center;color:#8b93a7;">এখনো রেজাল্ট পাবলিশ হয়নি</p>';
    } else {
        body += joins.map((j, idx) => {
            let name = j.inGameName || j.player1 || '—';
            if (j.roles) {
                const r = j.roles;
                name = [r.rusher, r.second, r.bomber, r.sniper].filter(Boolean).join(' · ') || name;
            } else if (j.player2) name = (j.player1 || '') + ' + ' + j.player2;
            const pos = Number(j.position) || 0;
            const kills = Number(j.kills) || 0;
            const amt = Number(j.prizeAmount) || 0;
            return `
            <div style="background:rgba(255,255,255,0.04);padding:12px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.08);">
                <div style="display:flex;justify-content:space-between;gap:8px;">
                    <strong style="color:#7eb0ff;">#${pos || (idx + 1)} ${name}</strong>
                    <span style="color:#00d68f;font-weight:700;">${amt} TK</span>
                </div>
                <div style="font-size:12px;color:#8b93a7;margin-top:4px;">
                    Position: ${pos || '—'} · Kills: ${kills}${perKill ? ' × ' + perKill + ' TK' : ''}
                    ${j.teamName ? ' · Team: ' + j.teamName : ''}
                </div>
            </div>`;
        }).join('');
    }

    if (match.pointTableImage) {
        body += `
        <div style="margin-top:12px;text-align:center;">
            <p style="font-size:12px;color:#8b93a7;margin-bottom:6px;">Point Table</p>
            <img src="${match.pointTableImage}" style="width:100%;max-height:40vh;object-fit:contain;border-radius:10px;">
        </div>`;
    }

    showModal('Match Result', body, [{ text: 'Close', class: 'btn-sm', action: closeModal }]);
}

async function adminUploadPointTable(matchId, inputEl) {
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;
    try {
        toast('Point table আপলোড হচ্ছে...');
        const dataUrl = await fileToThumbDataUrl(file, 1200, 0.82);
        const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
        if (!m) return toast('Match not found');
        m.pointTableImage = dataUrl;
        await cloudSet('matches', m.id, { pointTableImage: dataUrl });
        const rec = (CACHE.matchResults || []).find(r => String(r.matchId) === String(m.id) || String(r.id) === String(m.id));
        if (rec) {
            rec.pointTableImage = dataUrl;
            await cloudSet('matchResults', rec.id, { pointTableImage: dataUrl });
        }
        toast('Point Table আপলোড হয়েছে');
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast(e.message || 'আপলোড ব্যর্থ');
    } finally {
        if (inputEl) inputEl.value = '';
    }
}

async function adminSetPointTableUrl(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const input = document.getElementById('pt-url-' + matchId);
    const url = (input && input.value ? input.value : '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return toast('সঠিক Image URL দিন (https://...)');
    try {
        const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
        if (!m) return toast('Match not found');
        m.pointTableImage = url;
        await cloudSet('matches', m.id, { pointTableImage: url });
        const rec = (CACHE.matchResults || []).find(r => String(r.matchId) === String(m.id) || String(r.id) === String(m.id));
        if (rec) {
            rec.pointTableImage = url;
            await cloudSet('matchResults', rec.id, { pointTableImage: url });
        }
        toast('Point Table URL সেভ হয়েছে');
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast(e.message || 'সেভ ব্যর্থ');
    }
}

function getMyMatchStatus(m) {
    if (!m) return 'completed';
    const st = String(m.status || '').toLowerCase();
    if (st === 'completed' || st === 'result' || st === 'cancelled' || st === 'deleted' || m.movedToResults || m.resultPublished) {
        return 'completed';
    }
    // Result record exists → completed
    try {
        const hasResult = (CACHE.matchResults || []).some(r =>
            String(r.matchId) === String(m.id) || String(r.id) === String(m.id)
        );
        if (hasResult) return 'completed';
    } catch (e) {}

    const now = Date.now();
    const start = new Date(m.startTime).getTime();
    const hasRoom = !!(String(m.roomId || '').trim() && String(m.roomPass || '').trim());

    // Password not given yet → always Upcoming (even if start time passed)
    if (!hasRoom) return 'upcoming';

    // Password given + start time reached → Ongoing
    if (start <= now) return 'ongoing';

    // Password given but match not started yet → Upcoming
    return 'upcoming';
}

function filterMyMatchesTab(tab) {
    tab = tab || 'upcoming';
    const list = $('#my-matches-list');
    if (!list) return;
    const cards = list.querySelectorAll('.match-card[data-status]');
    let visible = 0;
    cards.forEach(card => {
        const show = card.getAttribute('data-status') === tab;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    let empty = list.querySelector('.my-matches-empty-tab');
    if (visible === 0) {
        if (!empty) {
            empty = document.createElement('div');
            empty.className = 'empty-state my-matches-empty-tab';
            empty.innerHTML = '<i class="fas fa-list"></i><p>এই ট্যাবে কোনো ম্যাচ নেই</p>';
            list.appendChild(empty);
        }
        empty.style.display = '';
    } else if (empty) {
        empty.style.display = 'none';
    }
}

function bindMyMatchesTabs() {
    const tabs = document.querySelectorAll('#my-matches-page .tabs .tab');
    tabs.forEach(btn => {
        if (btn._mmBound) return;
        btn._mmBound = true;
        btn.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            filterMyMatchesTab(btn.getAttribute('data-tab') || 'upcoming');
        });
    });
}

function loadMyMatches() {
    const joins = (CACHE.joins || []).filter(j =>
        String(j.userId) === String(currentUser.id) && !j.refunded
    );
    const matches = CACHE.matches || [];
    const list = $('#my-matches-list');
    if (!list) return;

    bindMyMatchesTabs();

    if (joins.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-list"></i><p>আপনি এখনো কোনো ম্যাচ জয়েন করেননি</p></div>`;
        return;
    }

    // Newest first
    const sorted = joins.slice().sort((a, b) => {
        const ma = matches.find(x => String(x.id) === String(a.matchId));
        const mb = matches.find(x => String(x.id) === String(b.matchId));
        const ta = ma ? new Date(ma.startTime).getTime() : 0;
        const tb = mb ? new Date(mb.startTime).getTime() : 0;
        return tb - ta;
    });

    list.innerHTML = sorted.map(j => {
        const m = matches.find(x => String(x.id) === String(j.matchId));
        // Match deleted but join remains — treat as completed if result exists, else hide
        if (!m) {
            const hasResult = (CACHE.matchResults || []).some(r =>
                String(r.matchId) === String(j.matchId)
            );
            if (!hasResult) return '';
            return `
            <div class="match-card" data-status="completed">
                <div class="match-card-header">
                    <div class="match-thumb"><i class="fas fa-fire"></i></div>
                    <div class="match-title-info">
                        <h3>${j.matchTitle || 'Match'}</h3>
                        <p><span style="color:#00b894">COMPLETED</span></p>
                    </div>
                </div>
                <div style="padding:0 15px 10px;font-size:13px;">
                    <p><strong>In-Game Name:</strong> ${j.inGameName || '—'}</p>
                </div>
                <div class="match-actions">
                    <button class="btn-prize" onclick="showJoinReceiptFromMyMatches('${j.matchId}', '${j.id}')"><i class="fas fa-receipt"></i> Receipt</button>
                </div>
            </div>`;
        }

        const status = getMyMatchStatus(m);
        const statusColor = status === 'completed' ? '#00b894' : status === 'ongoing' ? '#e17055' : '#6c5ce7';
        const statusLabel = status.toUpperCase();

        return `
        <div class="match-card" data-status="${status}">
            <div class="match-card-header">
                <div class="match-thumb"><i class="fas fa-fire"></i></div>
                <div class="match-title-info">
                    <h3>${m.title || 'Match'}</h3>
                    <p>${formatTime(m.startTime)} • <span style="color:${statusColor}">${statusLabel}</span></p>
                </div>
            </div>
            <div class="match-details">
                <div class="detail-item"><div class="label">Prize</div><div class="value prize">${m.winPrize || 0} TK</div></div>
                <div class="detail-item"><div class="label">Entry</div><div class="value">${m.entryFee || 0} TK</div></div>
                <div class="detail-item"><div class="label">Type</div><div class="value">${m.entryType || '—'}</div></div>
            </div>
            <div style="padding:0 15px 10px;font-size:13px;">
                <p><strong>In-Game Name:</strong> ${j.inGameName || '—'}</p>
                ${j.type ? `<p style="margin-top:3px;"><strong>Type:</strong> ${j.type}</p>` : ''}
            </div>
            <div class="match-actions">
                <button class="btn-room" onclick="showRoomDetails('${m.id}')"><i class="fas fa-key"></i> Room Details</button>
                <button class="btn-prize" onclick="showJoinReceiptFromMyMatches('${m.id}', '${j.id}')"><i class="fas fa-receipt"></i> Receipt</button>
            </div>
        </div>`;
    }).join('');

    const activeTab = document.querySelector('#my-matches-page .tabs .tab.active');
    const tab = (activeTab && activeTab.getAttribute('data-tab')) || 'upcoming';
    filterMyMatchesTab(tab);
}

function loadResults() {
    try { ensureMatchResultsListener(); } catch (e) {}
    return _loadResultsImpl();
}
function _loadResultsImpl() {
    const list = $('#results-list');
    if (!list) return;
    // Only PUBLIC results from matchResults (survive match delete)
    const results = (CACHE.matchResults || [])
        .filter(r => r.public)
        .sort((a, b) => new Date(b.startTime || b.createdAt || 0) - new Date(a.startTime || a.createdAt || 0));
    if (results.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-trophy"></i><p>এখনো কোনো পাবলিক রেজাল্ট নেই</p></div>`;
        return;
    }
    const isAdm = !!(currentUser && currentUser.isAdmin);
    list.innerHTML = results.map(r => `
        <div class="match-card" onclick="showStoredMatchResult('${r.id}')" style="cursor:pointer;">
            <div class="match-card-header">
                <div class="match-thumb"><i class="fas fa-trophy"></i></div>
                <div class="match-title-info">
                    <h3>${r.title || 'Match'}</h3>
                    <p>${r.startTime ? formatTime(r.startTime) : ''}</p>
                </div>
            </div>
            <div style="padding:12px 15px;font-size:13px;">
                <p><strong>${r.isProLeague ? 'Champion' : 'Winner'}:</strong> ${r.championTeam || r.winner || 'TBA'}</p>
                <p style="margin-top:5px;"><strong>Prize pool:</strong> ${r.winPrize || 0} TK</p>
                <p style="margin-top:8px;font-size:12px;color:#5b9dff;">ক্লিক করে পুরো রেজাল্ট দেখুন →</p>
                ${isAdm ? `<button type="button" class="btn-sm delete" style="margin-top:10px;width:100%;"
                    onclick="event.stopPropagation();adminDeleteMatchResult('${r.id}')">Delete Result</button>` : ''}
            </div>
        </div>
    `).join('');
}

function showStoredMatchResult(resultId) {
    const r = (CACHE.matchResults || []).find(x => String(x.id) === String(resultId));
    if (!r || !r.public) return toast('রেজাল্ট পাওয়া যায়নি');
    let body = `
        <p style="font-size:14px;color:#e8ecf8;margin-bottom:6px;"><strong>${r.title || ''}</strong></p>
        <p style="font-size:13px;color:#ffb84d;margin-bottom:12px;">
            ${r.isProLeague ? 'Champion Team' : 'Winner'}: <strong>${r.championTeam || r.winner || 'TBA'}</strong>
        </p>`;
    const teams = Array.isArray(r.teamPrizes) ? r.teamPrizes.filter(t => t && (t.teamName || t.amount)) : [];
    if (teams.length) {
        body += '<h4 style="font-size:13px;color:#c5cbe0;margin:0 0 8px;">Team Prize List</h4>';
        body += teams.map((t, i) => `
            <div style="background:rgba(255,255,255,0.04);padding:10px;border-radius:10px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;">
                <span style="color:#7eb0ff;">#${t.position || (i + 1)} ${t.teamName || '—'}</span>
                <strong style="color:#00d68f;">${Number(t.amount) || 0} TK</strong>
            </div>`).join('');
    }
    // player level from joins if match still exists
    const joins = (CACHE.joins || []).filter(j =>
        String(j.matchId) === String(r.matchId) && !j.refunded && (j.prizePaid || j.position || j.kills)
    ).sort((a, b) => (Number(a.position) || 999) - (Number(b.position) || 999));
    if (joins.length) {
        body += '<h4 style="font-size:13px;color:#c5cbe0;margin:12px 0 8px;">Player Results</h4>';
        body += joins.map((j, idx) => {
            let name = j.inGameName || j.player1 || '—';
            if (j.roles) {
                const rr = j.roles;
                name = [rr.rusher, rr.second, rr.bomber, rr.sniper].filter(Boolean).join(' · ') || name;
            }
            return `<div style="background:rgba(255,255,255,0.04);padding:10px;border-radius:10px;margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;"><strong style="color:#7eb0ff;">${name}</strong>
                <span style="color:#00d68f;">${Number(j.prizeAmount) || 0} TK</span></div>
                <div style="font-size:12px;color:#8b93a7;">Pos: ${j.position || '—'} · Kills: ${j.kills || 0}</div>
            </div>`;
        }).join('');
    }
    if (r.pointTableImage) {
        body += `<div style="margin-top:12px;text-align:center;">
            <p style="font-size:12px;color:#8b93a7;margin-bottom:6px;">Point Table</p>
            <img src="${r.pointTableImage}" style="width:100%;max-height:40vh;object-fit:contain;border-radius:10px;">
        </div>`;
    }
    if (!teams.length && !joins.length && !r.pointTableImage) {
        body += '<p style="text-align:center;color:#8b93a7;">বিস্তারিত রেজাল্ট এখনো যোগ হয়নি</p>';
    }
    showModal('Match Result', body, [{ text: 'Close', class: 'btn-sm', action: closeModal }]);
}

function loadRules() {
    const cats = getCategories();
    const modeRules = CACHE.modeRules || {};
    const keys = getCategoryKeys();
    if (keys.length === 0) {
        $('#rules-content').innerHTML = '<p>কোনো মোড নেই</p>';
        return;
    }
    const first = keys[0];
    let tabsHtml = keys.map((k, i) =>
        `<button class="rule-tab ${i === 0 ? 'active' : ''}" data-mode="${k}" onclick="showModeRule('${k}')">${cats[k].name}</button>`
    ).join('');

    $('#rules-content').innerHTML = `
        <div class="rule-tabs" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:15px;">${tabsHtml}</div>
        <div id="mode-rule-body" class="rules-content" style="line-height:1.85;">${modeRules[first] ? formatRulesHtml(modeRules[first]) : '<p>এই মোডের রুলস এখনো সেট করা হয়নি।</p>'}</div>
    `;
}

function showModeRule(modeKey) {
    const modeRules = CACHE.modeRules || {};
    $$('.rule-tab').forEach(t => t.classList.remove('active'));
    const btn = $(`.rule-tab[data-mode="${modeKey}"]`);
    if (btn) btn.classList.add('active');
    const body = $('#mode-rule-body');
    if (body) body.innerHTML = modeRules[modeKey] ? formatRulesHtml(modeRules[modeKey]) : '<p>এই মোডের রুলস এখনো সেট করা হয়নি।</p>';
}
window.showModeRule = showModeRule;


function getUserPrizeEarned(u) {
    if (!u) return 0;
    if (u.totalPrizeEarned != null && u.totalPrizeEarned !== '') {
        return Number(u.totalPrizeEarned) || 0;
    }
    return (CACHE.transactions || [])
        .filter(t => String(t.userId) === String(u.id) && t.type === 'prize' && (t.status === 'completed' || t.status === 'approved'))
        .reduce((s, t) => s + (Number(t.amount) || 0), 0);
}

/** Build public leaderboard from user docs — survives match delete */
async function syncPublicLeaderboard() {
    try {
        let all = CACHE.users || [];
        if (currentUser && currentUser.isAdmin && firebaseReady) {
            try { all = await cloudGetAll('users'); CACHE.users = all; } catch (e) {}
        }
        // Also fold prize txs so missing totalPrizeEarned still counts
        const txSum = {};
        (CACHE.transactions || []).forEach(t => {
            if (t.type !== 'prize') return;
            if (t.status && t.status !== 'approved' && t.status !== 'completed') return;
            const id = String(t.userId);
            txSum[id] = (txSum[id] || 0) + (Number(t.amount) || 0);
        });
        const board = (all || [])
            .filter(u => u && !u.isAdmin)
            .map(u => {
                const fromField = Number(u.totalPrizeEarned) || 0;
                const fromTx = txSum[String(u.id)] || 0;
                const prize = Math.max(fromField, fromTx);
                return {
                    id: u.id,
                    username: u.username || '',
                    nickname: u.nickname || '',
                    verified: !!u.verified,
                    totalPrizeEarned: prize,
                    totalWins: Number(u.totalWins) || 0
                };
            })
            .filter(r => r.totalPrizeEarned > 0)
            .sort((a, b) => b.totalPrizeEarned - a.totalPrizeEarned || b.totalWins - a.totalWins)
            .slice(0, 50);
        CACHE.leaderboard = board;
        await cloudSetConfig('leaderboard', board);
        return board;
    } catch (e) {
        console.warn('syncPublicLeaderboard', e);
        return CACHE.leaderboard || [];
    }
}


async function adminRebuildLeaderboard() {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    toast('Leaderboard আপডেট হচ্ছে...');
    try {
        await loadAllUsersForAdmin();
        const board = await syncPublicLeaderboard();
        toast('Top Players আপডেট: ' + (board ? board.length : 0) + ' জন');
    } catch (e) {
        console.error(e);
        toast('Rebuild ব্যর্থ');
    }
}

async function loadTopPlayers() {
    const list = $('#top-players-list');
    if (!list) return;
    list.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>লোড হচ্ছে...</p></div>`;

    // 1) Public config (all users can read)
    let board = [];
    try {
        board = await cloudGetConfig('leaderboard', null);
        if (Array.isArray(board)) CACHE.leaderboard = board;
        else board = CACHE.leaderboard || [];
    } catch (e) {
        board = CACHE.leaderboard || [];
    }

    // 2) Admin / if local users available — rebuild so list stays fresh
    const localUsers = (CACHE.users || []).filter(u => u && !u.isAdmin);
    if (currentUser && currentUser.isAdmin) {
        try { board = await syncPublicLeaderboard(); } catch (e) {}
    } else if ((!board || !board.length) && localUsers.length) {
        board = localUsers.map(u => ({
            id: u.id,
            username: u.username || '',
            nickname: u.nickname || '',
            verified: !!u.verified,
            totalPrizeEarned: getUserPrizeEarned(u),
            totalWins: Number(u.totalWins) || 0
        })).filter(r => r.totalPrizeEarned > 0)
          .sort((a, b) => b.totalPrizeEarned - a.totalPrizeEarned)
          .slice(0, 50);
        CACHE.leaderboard = board;
    }

    board = (board || []).filter(r => (Number(r.totalPrizeEarned) || 0) > 0)
        .sort((a, b) => (Number(b.totalPrizeEarned) || 0) - (Number(a.totalPrizeEarned) || 0))
        .slice(0, 20);

    if (!board.length) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-chart-line"></i><p>এখনো কেউ ম্যাচ প্রাইজ পায়নি</p><p style="font-size:12px;color:#8b93a7;margin-top:8px;">প্রাইজ দেওয়ার পর এখানে অটো দেখাবে। ম্যাচ ডিলিট হলেও লিস্ট থাকবে।</p></div>`;
        return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = board.map((row, i) => {
        const name = (row.nickname || row.username || 'Player') + (row.verified ? ' ✓' : '');
        const prize = Number(row.totalPrizeEarned) || 0;
        const uname = row.username || '';
        if (i < 3) {
            const bg = i === 0
                ? 'linear-gradient(135deg,rgba(255,215,0,0.18),rgba(255,165,0,0.08))'
                : i === 1
                    ? 'linear-gradient(135deg,rgba(192,192,192,0.16),rgba(255,255,255,0.05))'
                    : 'linear-gradient(135deg,rgba(205,127,50,0.16),rgba(255,140,0,0.06))';
            const border = i === 0 ? 'rgba(255,215,0,0.45)' : i === 1 ? 'rgba(200,200,200,0.4)' : 'rgba(205,127,50,0.4)';
            const nameSize = i === 0 ? '22px' : '20px';
            return `
            <div style="margin-bottom:14px;padding:16px 14px;border-radius:14px;background:${bg};border:1px solid ${border};">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="font-size:36px;line-height:1;">${medals[i]}</div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:${nameSize};font-weight:800;color:#fff;letter-spacing:0.3px;word-break:break-word;">${name}</div>
                        <div style="font-size:12px;color:#a0a8bc;margin-top:2px;">@${uname}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:18px;font-weight:800;color:#ffd700;">${prize} TK</div>
                        <div style="font-size:11px;color:#8b93a7;">ম্যাচ প্রাইজ</div>
                    </div>
                </div>
            </div>`;
        }
        return `
        <div class="tx-item" style="margin-bottom:8px;">
            <div class="tx-info">
                <h4 style="font-size:14px;">#${i + 1} ${name}</h4>
                <p>@${uname}</p>
            </div>
            <div style="text-align:right;font-size:13px;">
                <div style="font-weight:700;color:#a78bfa;">${prize} TK</div>
                <div style="color:#636e72;font-size:11px;">ম্যাচ প্রাইজ</div>
            </div>
        </div>`;
    }).join('');
}

// ==================== ADMIN ====================

async function adminDeletePointTable(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    if (!confirm('Point Table ডিলিট করবেন?')) return;
    try {
        const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
        if (m) {
            m.pointTableImage = '';
            await cloudSet('matches', m.id, { pointTableImage: '' });
        }
        const rec = (CACHE.matchResults || []).find(r =>
            String(r.matchId) === String(matchId) || String(r.id) === String(matchId)
        );
        if (rec) {
            rec.pointTableImage = '';
            await cloudSet('matchResults', rec.id, { pointTableImage: '' });
        }
        toast('Point Table ডিলিট হয়েছে');
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast(e.message || 'ডিলিট ব্যর্থ');
    }
}


async function loadAdmin(tab = 'matches') {
    $$('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.admin === tab));
    const container = $('#admin-content');
    if (!container) return;
    if (tab === 'matches') renderAdminMatches(container);
    else if (tab === 'deposits') {
        try {
            CACHE.transactions = await cloudGetAll('transactions');
        } catch (e) { console.error(e); }
        renderAdminDeposits(container);
    }
    else if (tab === 'withdraws') {
        try {
            CACHE.transactions = await cloudGetAll('transactions');
        } catch (e) { console.error(e); }
        renderAdminWithdraws(container);
    }
    else if (tab === 'users') {
        container.innerHTML = '<p style="color:#8b93a7;padding:12px;">Users লোড হচ্ছে...</p>';
        try { await loadAllUsersForAdmin(); } catch (e) { console.error(e); }
        renderAdminUsers(container);
    }
    else if (tab === 'results-dist') renderAdminResultDist(container);
    else if (tab === 'rules') renderAdminRules(container);
    else if (tab === 'pro-control') renderAdminProLeagueControl(container);
    else if (tab === 'settings') {
        (async () => {
            try {
                if (firebaseReady) {
                    CACHE.joins = await cloudGetAll('joins');
                    CACHE.matches = await cloudGetAll('matches');
                }
            } catch (e) { console.warn(e); }
            renderAdminSettings(container);
        })();
    }
}

function renderAdminMatches(container) {
    const cats = getCategories();
    // Normal categories only (hide pro-* from main list — Pro League is separate option)
    const normalOpts = getCategoryKeys()
        .filter(k => !isProLeagueCategory(k))
        .map(k => `<option value="${k}">${cats[k].name}</option>`)
        .join('');
    const later = new Date(Date.now() + 3600000);
    // Hide completed / cancelled / deleted — only active matches in this list
    const _seenIds = {};
    const matchesAll = (CACHE.matches || [])
        .filter(m => {
            if (!isActiveMatch(m)) return false;
            const id = String(m.id);
            if (_seenIds[id]) return false;
            _seenIds[id] = true;
            return true;
        })
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const filterCat = adminMatchesCatFilter || 'all';
    const matches = filterCat === 'all'
        ? matchesAll
        : matchesAll.filter(m => String(m.category || '') === String(filterCat));
    const deletedMatches = (CACHE.matches || [])
        .filter(m => String(m.status || '').toLowerCase() === 'deleted')
        .slice()
        .sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
    const MAP_OPTS = ['Bermuda','Purgatory','Kalahari','Alpine','Nexterra','Solara'];

    container.innerHTML = `
        <div class="admin-section">
            <h3>➕ Create Match</h3>
            <div class="form-group">
                <label>Category</label>
                <select id="am-category">
                    ${normalOpts}
                    <option value="__pro_league__">Pro League</option>
                </select>
            </div>
            <div id="am-pro-wrap" class="hidden">
                <div class="form-group">
                    <label>Pro League Mode</label>
                    <select id="am-pro-mode">
                        <option value="pro-champion-rush">Champion Rush (৬ ম্যাপ)</option>
                        <option value="pro-point-rush">Point Rush (৬ ম্যাপ)</option>
                        <option value="pro-scrim">Scrim (৩ ম্যাপ)</option>
                        <option value="pro-qualified">Qualified Tournament (৬ ম্যাপ · Groups)</option>
                        <option value="pro-versus">Versus (Team vs Team)</option>
                    </select>
                </div>
                <p style="font-size:12px;color:#8b93a7;margin:4px 0 8px;" id="am-pro-hint">Champion Rush সিলেক্ট — নিচে ৬টা ম্যাপ বেছে নিন</p>
                <div id="am-pro-maps"></div>
            </div>
            <div class="form-group"><label>Title</label><input type="text" id="am-title" placeholder="Solo Time | Mobile | Regular"></div>
            <div class="form-group"><label>Entry Type</label>
                <select id="am-entrytype">
                    <option value="Solo">Solo</option>
                    <option value="Duo">Duo</option>
                    <option value="Squad">Squad</option>
                    <option value="Solo/Duo">Solo/Duo</option>
                    <option value="Pro League">Pro League (Team)</option>
                </select>
            </div>
            <div class="form-group"><label>Win Prize (TK)</label><input type="number" id="am-winprize" value="100"></div>
            <div class="form-group"><label>Entry Fee (TK)</label><input type="number" id="am-entryfee" value="10"></div>
            <div class="form-group"><label>Per Kill (TK)</label><input type="number" id="am-perkill" value="5"></div>
            <div class="form-group"><label>Max Players / Slots</label><input type="number" id="am-maxplayers" value="48"></div>
            <div class="form-group" id="am-single-map-wrap">
                <label>Map</label>
                <select id="am-map">
                    ${MAP_OPTS.map(m => `<option>${m}</option>`).join('')}
                    <option>All Maps</option>
                </select>
            </div>
            <div class="form-group"><label>Version</label>
                <select id="am-version"><option>Mobile</option><option>Emulator</option><option>Mixed</option></select>
            </div>
            <div class="form-group"><label>Start Time (প্রথম ম্যাচ)</label><input type="datetime-local" id="am-start"></div>
            <div class="form-group"><label>Room ID (optional)</label><input type="text" id="am-roomid"></div>
            <div class="form-group"><label>Room Pass (optional)</label><input type="text" id="am-roompass"></div>
            <div class="form-group"><label>Thumbnail URL (optional)</label><input type="text" id="am-thumb"></div>
            <p style="font-size:12px;color:#8b93a7;margin:8px 0 4px;" id="am-prize-hint">প্রাইজ লিস্ট (ঐচ্ছিক)</p>
            <div id="am-prize-fields"></div>
            <div class="form-group">
                <label>প্রাইজ নোট / Notice (ঐচ্ছিক)</label>
                <textarea id="am-prize-note" rows="2" placeholder="যেমন: Weekly Light Free · Winner takes all"
                    style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);resize:vertical;"></textarea>
                <p style="font-size:11px;color:#8b93a7;margin:4px 0 0;">প্লেয়াররা Prize Details-এ এই নোট দেখবে</p>
            </div>
            <button type="button" class="btn-primary" id="btn-create-match" onclick="adminCreateMatch()">Create Match</button>
        </div>
        <div class="admin-section">
            <h3>📋 Active Matches (${matches.length}${filterCat !== 'all' ? ' / ' + matchesAll.length : ''})</h3>
            <p style="font-size:12px;color:#8b93a7;margin:-4px 0 12px;">Send to Results করলে এখান থেকে উঠে যাবে · ফেরাতে Result Dist → Back to Play</p>
            <div class="form-group" style="margin-bottom:12px;">
                <label>Category Filter</label>
                <select id="admin-match-cat-filter" onchange="adminMatchesCatFilter=this.value;renderAdminMatches(document.getElementById('admin-content')||this.closest('.admin-body')||document.querySelector('#admin-content'));">
                    <option value="all" ${filterCat==='all'?'selected':''}>All Match</option>
                    ${getCategoryKeys().map(k => `<option value="${k}" ${filterCat===k?'selected':''}>${(cats[k]&&(cats[k].name||cats[k].title))||k}</option>`).join('')}
                </select>
            </div>
            ${matches.length === 0 ? '<p style="color:#636e72;">কোনো ম্যাচ নেই</p>' : matches.map(m => `
                <div class="admin-match-item">
                    <h4>${m.title} <small style="color:#636e72;">(${m.category})</small></h4>
                    <p style="font-size:12px;color:#636e72;">
                        ${formatTime(m.startTime)} | Fee: ${m.entryFee} | Prize: ${m.winPrize} |
                        Map: ${m.map || '—'} | Players: ${getJoinedCount(m.id)}/${m.maxPlayers || 48} | Status: ${m.status}
                    </p>
                    <div class="admin-actions" style="flex-wrap:wrap;">
                        <button class="btn-sm edit" onclick="adminEditMatch('${m.id}')">Edit</button>
                        <button class="btn-sm edit" onclick="adminEditRoom('${m.id}')">Room</button>
                        <button class="btn-sm" style="background:${m.registrationClosed ? '#00b894' : '#fdcb6e'};color:${m.registrationClosed ? '#fff' : '#2d3436'};" onclick="adminToggleRegistration('${m.id}')">${m.registrationClosed ? 'Open Registration' : 'Close Registration'}</button>
                        <button class="btn-sm info" onclick="adminViewPlayers('${m.id}')">Players</button>
                        ${String(m.category) === 'pro-versus' ? `<button class="btn-sm edit" onclick="adminEditVersusMatch(${m.id})">Edit Logos</button>` : ''}
                        <button class="btn-sm" style="background:#00b894;color:#fff;" onclick="adminCopyMatch('${m.id}')">Copy Match</button>
                        <button class="btn-sm" style="background:#6c5ce7;color:#fff;" onclick="adminOpenResults('${m.id}')">Results / Prize</button>
                        ${m.status === 'completed' ? `<button class="btn-sm approve" onclick="adminRestoreMatchFromResults('${m.id}')">Back to Play</button>` : `<button class="btn-sm approve" onclick="adminCompleteMatch('${m.id}')">Send to Results</button>`}
                        <button class="btn-sm" style="background:#e17055;color:#fff;" onclick="adminRefundMatch('${m.id}')">Refund All</button>
                        <button class="btn-sm delete" onclick="adminDeleteMatch('${m.id}')">Delete</button>
                    </div>
                    ${isProLeagueCategory(m.category) && String(m.category) !== 'pro-versus' ? `
                    <div class="form-group" style="margin-top:8px;">
                        <label style="font-size:12px;">Point Table ছবি (Gallery) — শুধু Pro League</label>
                        <input type="file" accept="image/*" onchange="adminUploadPointTable('${m.id}', this)"
                            style="width:100%;padding:8px;border-radius:8px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">
                        <label style="font-size:12px;margin-top:8px;display:block;">অথবা Image URL</label>
                        <div style="display:flex;gap:8px;margin-top:4px;">
                            <input type="url" id="pt-url-${m.id}" placeholder="https://...jpg / png"
                                style="flex:1;padding:8px;border-radius:8px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">
                            <button type="button" class="btn-sm" style="background:#1a5cff;color:#fff;white-space:nowrap;"
                                onclick="adminSetPointTableUrl('${m.id}')">Save URL</button>
                        </div>
                        ${m.pointTableImage ? `<p style="font-size:11px;color:#00d68f;margin-top:4px;">✓ Point table set</p>
                        <button type="button" class="btn-sm delete" style="margin-top:6px;" onclick="adminDeletePointTable('${m.id}')">Delete Point Table</button>` : '<p style="font-size:11px;color:#8b93a7;margin-top:4px;">এখনো সেট হয়নি</p>'}
                    </div>` : ''}
                </div>
            `).join('')}
        </div>

        <div style="margin-top:22px;">
            <h3 style="margin-bottom:8px;">🗑️ Deleted Matches (${deletedMatches.length})</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;line-height:1.45;">
                ভুল করে ডিলিট হলে এখান থেকে <strong>Restore</strong> চাপলে ম্যাচ + Join আগের মতো ফিরে আসবে।
                স্থায়ী মুছতে <strong>Permanent Delete</strong> ব্যবহার করুন।
            </p>
            ${deletedMatches.length === 0 ? '<p style="text-align:center;color:#636e72;padding:12px 0;">কোনো ডিলিটেড ম্যাচ নেই</p>' : deletedMatches.map(m => `
                <div class="admin-card" style="border:1px solid rgba(225,112,85,0.35);">
                    <strong>${m.title || 'Match'}</strong>
                    <span class="badge" style="background:#e17055;">deleted</span>
                    <div style="font-size:12px;color:#8b93a7;margin:6px 0;">
                        ${(m.category || '')} · ${formatTime(m.startTime)} · Fee: ${m.entryFee || 0} · Prize: ${m.winPrize || 0}<br>
                        Players (saved): ${getJoinedCount(m.id)}/${m.maxPlayers || 48}
                        ${m.deletedAt ? ' · Deleted: ' + formatTime(m.deletedAt) : ''}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
                        <button class="btn-sm approve" onclick="adminRestoreDeletedMatch('${m.id}')">♻️ Restore</button>
                        <button class="btn-sm delete" onclick="adminPermanentDeleteMatch('${m.id}')">Permanent Delete</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    $('#am-start').value = later.toISOString().slice(0, 16);

    const mapSelectHtml = (id) => `
        <select id="${id}">
            ${MAP_OPTS.map(m => `<option>${m}</option>`).join('')}
        </select>`;

    function renderProMaps() {
        const mode = $('#am-pro-mode')?.value || 'pro-champion-rush';
        const isVersus = mode === 'pro-versus';
        // Fixed map counts: Scrim=3, others=6, Versus=0 (no maps required)
        const count = mode === 'pro-scrim' ? 3 : (mode === 'pro-versus' ? 0 : 6);
        const hint = $('#am-pro-hint');
        if (hint) {
            const names = {
                'pro-champion-rush': 'Champion Rush',
                'pro-point-rush': 'Point Rush',
                'pro-scrim': 'Scrim',
                'pro-qualified': 'Qualified Tournament',
                'pro-versus': 'Versus'
            };
            if (isVersus) {
                hint.textContent = 'Versus — Team A vs Team B লোগো অ্যাড করুন';
            } else if (mode === 'pro-point-rush') {
                hint.textContent = 'Point Rush — ৬ ম্যাপ সিলেক্ট করুন';
            } else if (mode === 'pro-scrim') {
                hint.textContent = 'Scrim — ৩ ম্যাপ সিলেক্ট করুন';
            } else {
                hint.textContent = mode === 'pro-qualified'
                ? 'Qualified Tournament — ৬ ম্যাপ · গ্রুপ জয়েনে সিলেক্ট'
                : ((names[mode] || mode) + ' — ৬ ম্যাপ সিলেক্ট করুন');
            }
        }
        const box = $('#am-pro-maps');
        if (!box) return;
        let html = '';
        // Team A/B logos ONLY for Versus mode
        if (isVersus) {
            html += `
            <div class="form-group"><label>Team A Name</label><input type="text" id="am-team-a-name" placeholder="Team A"></div>
            <div class="form-group"><label>Team A Logo URL</label><input type="url" id="am-team-a-logo" placeholder="https://...png"></div>
            <div class="form-group"><label>Team B Name</label><input type="text" id="am-team-b-name" placeholder="Team B"></div>
            <div class="form-group"><label>Team B Logo URL</label><input type="url" id="am-team-b-logo" placeholder="https://...png"></div>
            <div class="form-group"><label>ম্যাপ (ঐচ্ছিক)</label>${mapSelectHtml('am-promap-1')}</div>
            `;
        } else {
            // Qualified: group names field
            if (mode === 'pro-qualified') {
                html += `
                <div class="form-group">
                    <label>Group নাম (কমা দিয়ে লিখুন)</label>
                    <textarea id="am-groups" rows="3" placeholder="Group A, Group B, Group C, Group D, Group E, Group F, Group G" style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">Group A, Group B, Group C, Group D, Group E, Group F, Group G</textarea>
                    <p style="font-size:11px;color:#8b93a7;margin:4px 0 0;">উদাহরণ: Group A, Group B, Group C — যত খুশি যোগ করতে পারবেন</p>
                </div>`;
            }
            for (let i = 1; i <= count; i++) {
                html += `<div class="form-group"><label>ম্যাপ ${i}</label>${mapSelectHtml('am-promap-' + i)}</div>`;
            }
        }
        box.innerHTML = html;
        // default title
        const title = $('#am-title');
        const meta = PRO_LEAGUE_MODES[mode];
        if (title && meta) title.value = meta.name;
    }

    function onCategoryChange() {
        const cat = $('#am-category')?.value || '';
        const proWrap = $('#am-pro-wrap');
        const singleMap = $('#am-single-map-wrap');
        const isPro = cat === '__pro_league__';
        if (proWrap) proWrap.classList.toggle('hidden', !isPro);
        if (singleMap) singleMap.classList.toggle('hidden', isPro);
        if (isPro) {
            const et = $('#am-entrytype');
            if (et) et.value = 'Pro League';
            renderProMaps();
            refreshPrizeFields(true);
        } else {
            refreshPrizeFields(false);
        }
    }

    function refreshPrizeFields(forcePro) {
        const cat = $('#am-category')?.value || '';
        const proMode = $('#am-pro-mode')?.value || '';
        const isPro = forcePro || cat === '__pro_league__' || isProLeagueCategory(proMode);
        // Optional prize table at create time.
        let n = 5;
        if (cat === 'br-survival') n = 10;
        else if (proMode === 'pro-qualified' || (isPro && proMode === 'pro-qualified')) n = 12;
        else if (isPro) n = 8;
        // When category is Pro League and mode is Qualified → top 12
        if (cat === '__pro_league__' && proMode === 'pro-qualified') n = 12;
        const box = $('#am-prize-fields');
        const hint = $('#am-prize-hint');
        if (hint) {
            if (proMode === 'pro-qualified') {
                hint.textContent = 'Qualified Tournament — টপ ১২ পর্যন্ত প্রাইজ সেট করতে পারবেন (ঐচ্ছিক)';
            } else if (isPro) {
                hint.textContent = 'Pro League — ঐচ্ছিক প্রাইজ টেবিল (রেজাল্ট পরে Result Dist থেকে)';
            } else {
                hint.textContent = 'ঐচ্ছিক প্রাইজ টেবিল — ম্যাচ শেষে সব জয়েন প্লেয়ারকে Results থেকে প্রাইজ দিতে পারবেন';
            }
        }
        if (!box) return;
        let html = '';
        for (let i = 1; i <= n; i++) {
            html += `<div class="form-group"><label>${i}ম প্রাইজ (ঐচ্ছিক)</label><input type="number" id="am-prize${i}" placeholder="খালি রাখতে পারেন" min="0"></div>`;
        }
        box.innerHTML = html;
    }

    refreshPrizeFields(false);
    onCategoryChange();
    $('#am-category')?.addEventListener('change', onCategoryChange);
    $('#am-pro-mode')?.addEventListener('change', () => {
        renderProMaps();
        refreshPrizeFields(true);
    });
}

let _creatingMatch = false;
async function adminCreateMatch() {
    if (_creatingMatch) return toast('অপেক্ষা করুন...');
    const title = ($('#am-title').value.trim() || 'Solo Time | Mobile | Regular');
    const startVal = $('#am-start').value;
    if (!startVal) return toast('Start Time দিন');

    const catRaw = $('#am-category').value;
    const isPro = catRaw === '__pro_league__';
    let category = catRaw;
    let maps = [];

    if (isPro) {
        await ensureProLeagueCategory();
        category = $('#am-pro-mode')?.value || 'pro-champion-rush';
        if (category === 'pro-versus') {
            const m = ($('#am-promap-1')?.value || 'All Maps').trim();
            maps = [m];
        } else {
            const count = category === 'pro-scrim' ? 3 : 6;
            for (let i = 1; i <= count; i++) {
                const m = ($('#am-promap-' + i)?.value || 'Bermuda').trim();
                maps.push(m);
            }
            if (maps.length !== count) return toast(count + 'টা ম্যাপ সিলেক্ট করুন');
        }
    } else {
        maps = [($('#am-map')?.value || 'Bermuda')];
    }

    _creatingMatch = true;
    const btn = document.querySelector('#btn-create-match') || document.querySelector('button[onclick="adminCreateMatch()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }

    try {
        const prizeMax = (category === 'pro-qualified') ? 12 : 10;
        const prizes = collectPrizeInputs(prizeMax);
        const base = {
            category,
            entryType: isPro ? 'Pro League' : $('#am-entrytype').value,
            winPrize: parseInt($('#am-winprize').value) || 0,
            entryFee: parseInt($('#am-entryfee').value) || 0,
            perKill: parseInt($('#am-perkill').value) || 0,
            maxPlayers: parseInt($('#am-maxplayers').value) || 48,
            version: $('#am-version').value,
            roomId: $('#am-roomid').value.trim() || '',
            roomPass: $('#am-roompass').value.trim() || '',
            thumbnail: $('#am-thumb').value.trim() || '',
            prizes,
            prizeNote: (document.getElementById('am-prize-note') && document.getElementById('am-prize-note').value || '').trim(),
            status: 'upcoming',
            createdAt: new Date().toISOString()
        };
        const startMs = new Date(startVal).getTime();
        // Pro League = ONE match card, multiple maps inside (View)
        const mapLabel = isPro
            ? (maps.length > 1 ? (maps.length + ' Maps') : (maps[0] || 'All Maps'))
            : maps[0];

        const match = {
            ...base,
            id: generateId(),
            title: title,
            map: mapLabel,
            maps: isPro ? maps.slice() : [maps[0]],
            startTime: new Date(startMs).toISOString(),
            seriesTotal: maps.length,
            seriesId: isPro ? generateId() : null,
            oneFeeForSeries: isPro ? true : false,
            teamAName: (isPro && category === 'pro-versus') ? (($('#am-team-a-name')?.value || '').trim() || 'Team A') : '',
            teamBName: (isPro && category === 'pro-versus') ? (($('#am-team-b-name')?.value || '').trim() || 'Team B') : '',
            teamALogo: (isPro && category === 'pro-versus') ? (($('#am-team-a-logo')?.value || '').trim()) : '',
            teamBLogo: (isPro && category === 'pro-versus') ? (($('#am-team-b-logo')?.value || '').trim()) : '',
            groups: (isPro && category === 'pro-qualified')
                ? (() => {
                    const raw = ($('#am-groups')?.value || '').trim();
                    const list = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
                    return list.length ? list : ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G'];
                })()
                : null
        };
        await cloudSet('matches', match.id, match);
        if (!firebaseReady) {
            const exists = (CACHE.matches || []).some(m => String(m.id) === String(match.id));
            if (!exists) CACHE.matches.push(match);
        }

        toast(isPro
            ? `Pro League ম্যাচ তৈরি · ${mapLabel} (${maps.join(', ')})`
            : 'ম্যাচ তৈরি হয়েছে! সবাই দেখতে পাবে।');
        updateCategoryCounts();
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast('ম্যাচ তৈরি ব্যর্থ — আবার চেষ্টা করুন');
    } finally {
        _creatingMatch = false;
    }
}


async function adminToggleRegistration(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    const next = !match.registrationClosed;
    try {
        await cloudSet('matches', match.id, { registrationClosed: next });
        match.registrationClosed = next;
        toast(next ? 'Registration Closed — কেউ আর জয়েন করতে পারবে না' : 'Registration Open — আবার জয়েন করা যাবে');
        loadAdmin('matches');
        // refresh public list if open
        try {
            if (typeof currentCategory !== 'undefined' && currentCategory) renderMatches(currentCategory);
        } catch (e) {}
    } catch (e) {
        console.error(e);
        toast('আপডেট ব্যর্থ');
    }
}


/** Edit any match — time, title, prize, slots (no need to delete & re-upload) */
function adminEditMatch(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('ম্যাচ পাওয়া যায়নি');
    const isVersus = String(m.category) === 'pro-versus';
    const isPro = typeof isProLeagueCategory === 'function' ? isProLeagueCategory(m.category) : String(m.category || '').startsWith('pro-');
    let startVal = '';
    try {
        const d = new Date(m.startTime);
        if (!isNaN(d.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            startVal = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
    } catch (e) {}
    const mapsStr = Array.isArray(m.maps) && m.maps.length ? m.maps.join(', ') : (m.map || '');
    const versusFields = isVersus ? `
        <div class="form-group"><label>Team A Name</label>
            <input type="text" id="em-team-a-name" value="${String(m.teamAName || 'Team A').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Team A Logo URL</label>
            <input type="url" id="em-team-a-logo" value="${String(m.teamALogo || '').replace(/"/g, '&quot;')}" placeholder="https://...png"></div>
        <div class="form-group"><label>Team B Name</label>
            <input type="text" id="em-team-b-name" value="${String(m.teamBName || 'Team B').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Team B Logo URL</label>
            <input type="url" id="em-team-b-logo" value="${String(m.teamBLogo || '').replace(/"/g, '&quot;')}" placeholder="https://...png"></div>
    ` : '';
    const mapsField = isPro && !isVersus ? `
        <div class="form-group"><label>Maps (কমা দিয়ে আলাদা)</label>
            <input type="text" id="em-maps" value="${String(mapsStr).replace(/"/g, '&quot;')}" placeholder="Bermuda, Purgatory, Kalahari"></div>
    ` : (isVersus ? '' : `
        <div class="form-group"><label>Map</label>
            <input type="text" id="em-map" value="${String(m.map || '').replace(/"/g, '&quot;')}"></div>
    `);
    showModal('Edit Match', `
        <p style="font-size:12px;color:#8b93a7;margin:0 0 10px;">ভুল টাইম/প্রাইজ হলে ডিলিট না করে এখান থেকে ঠিক করুন · ${String(m.category || '')}</p>
        <div class="form-group"><label>Title</label>
            <input type="text" id="em-title" value="${String(m.title || '').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Start Time ⏰</label>
            <input type="datetime-local" id="em-start" value="${startVal}"></div>
        <div class="form-group"><label>Win Prize (TK)</label>
            <input type="number" id="em-winprize" value="${m.winPrize != null ? m.winPrize : 0}"></div>
        <div class="form-group"><label>Entry Fee (TK)</label>
            <input type="number" id="em-entryfee" value="${m.entryFee != null ? m.entryFee : 0}"></div>
        <div class="form-group"><label>Per Kill (TK)</label>
            <input type="number" id="em-perkill" value="${m.perKill != null ? m.perKill : 0}"></div>
        <div class="form-group"><label>Max Players / Slots</label>
            <input type="number" id="em-maxplayers" value="${m.maxPlayers || 48}"></div>
        ${mapsField}
        ${versusFields}
        <div class="form-group">
            <label>প্রাইজ নোট / Notice (ঐচ্ছিক)</label>
            <textarea id="em-prize-note" rows="2" placeholder="যেমন: Weekly Light Free"
                style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);resize:vertical;">${String(m.prizeNote || m.prizeNotice || '').replace(/</g, '&lt;')}</textarea>
        </div>
    `, [
        { text: 'Cancel', class: 'btn-secondary', action: closeModal },
        { text: 'Save', class: 'btn-primary', action: async () => {
            const title = (document.getElementById('em-title')?.value || '').trim() || m.title;
            const startRaw = document.getElementById('em-start')?.value;
            const winPrize = parseInt(document.getElementById('em-winprize')?.value, 10);
            const entryFee = parseInt(document.getElementById('em-entryfee')?.value, 10);
            const perKill = parseInt(document.getElementById('em-perkill')?.value, 10);
            const maxPlayers = parseInt(document.getElementById('em-maxplayers')?.value, 10) || 48;
            let startTime = m.startTime;
            if (startRaw) {
                const d = new Date(startRaw);
                if (!isNaN(d.getTime())) startTime = d.toISOString();
                else return toast('সঠিক টাইম দিন');
            } else {
                return toast('Start Time দিন');
            }
            // খালি ফিল্ড = 0 (পুরনো ভ্যালু রাখবে না)
            const patch = {
                title,
                startTime,
                winPrize: isNaN(winPrize) ? 0 : winPrize,
                entryFee: isNaN(entryFee) ? 0 : entryFee,
                perKill: isNaN(perKill) ? 0 : perKill,
                maxPlayers,
                prizeNote: (document.getElementById('em-prize-note') && document.getElementById('em-prize-note').value || '').trim()
            };
            if (isPro && !isVersus) {
                const rawMaps = (document.getElementById('em-maps')?.value || '').trim();
                if (rawMaps) {
                    const maps = rawMaps.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
                    if (maps.length) {
                        patch.maps = maps;
                        patch.map = maps.length > 1 ? (maps.length + ' Maps') : maps[0];
                        patch.seriesTotal = maps.length;
                    }
                }
            } else if (!isVersus) {
                const mapOne = (document.getElementById('em-map')?.value || '').trim();
                if (mapOne) { patch.map = mapOne; patch.maps = [mapOne]; }
            }
            if (isVersus) {
                patch.teamAName = (document.getElementById('em-team-a-name')?.value || '').trim() || 'Team A';
                patch.teamBName = (document.getElementById('em-team-b-name')?.value || '').trim() || 'Team B';
                patch.teamALogo = (document.getElementById('em-team-a-logo')?.value || '').trim();
                patch.teamBLogo = (document.getElementById('em-team-b-logo')?.value || '').trim();
            }
            try {
                const docId = m._docId != null ? m._docId : m.id;
                await cloudSet('matches', docId, patch);
                Object.assign(m, patch);
                // Keep CACHE in sync if another object instance exists
                const idx = (CACHE.matches || []).findIndex(x => String(x.id) === String(m.id) || String(x._docId || '') === String(docId));
                if (idx >= 0) Object.assign(CACHE.matches[idx], patch);
                toast('ম্যাচ আপডেট হয়েছে ✓');
                closeModal();
                try {
                    const cont = document.querySelector('#admin-page .admin-body') || document.querySelector('#admin-content');
                    if (cont && typeof renderAdminMatches === 'function') renderAdminMatches(cont);
                } catch (e) {}
                try {
                    if (typeof currentCategory !== 'undefined' && currentCategory) renderMatches(currentCategory);
                    if (typeof updateCategoryCounts === 'function') updateCategoryCounts();
                } catch (e) {}
            } catch (e) {
                console.error(e);
                toast('সেভ ব্যর্থ: ' + (e.message || 'error'));
            }
        }}
    ]);
}

function adminEditRoom(matchId) {
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('ম্যাচ পাওয়া যায়নি');
    const noteEsc = String(m.roomNote || m.roomNotice || '').replace(/</g, '&lt;');

    showModal('Set Room Details', `
        <div class="form-group">
            <label>Room ID</label>
            <input type="text" id="edit-roomid" value="${String(m.roomId || '').replace(/"/g, '&quot;')}" placeholder="Room ID">
        </div>
        <div class="form-group">
            <label>Password</label>
            <input type="text" id="edit-roompass" value="${String(m.roomPass || '').replace(/"/g, '&quot;')}" placeholder="Password">
        </div>
        <div class="form-group">
            <label>📌 Notice / নোট (ঐচ্ছিক)</label>
            <textarea id="edit-roomnote" rows="3" placeholder="যেমন: দ্রুত জয়েন করুন / Fast join please"
                style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);resize:vertical;">${noteEsc}</textarea>
            <p style="font-size:11px;color:#8b93a7;margin:6px 0 0;">রুম ডিটেইলসে দেখাবে — কপি বাটন থাকবে না। খালি রাখলে Notice দেখাবে না।</p>
        </div>
    `, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Save', class: 'btn-primary', action: async () => {
                const roomId = (document.getElementById('edit-roomid')?.value || '').trim();
                const roomPass = (document.getElementById('edit-roompass')?.value || '').trim();
                const roomNote = (document.getElementById('edit-roomnote')?.value || '').trim();
                m.roomId = roomId;
                m.roomPass = roomPass;
                m.roomNote = roomNote;
                const docId = m._docId != null ? m._docId : m.id;
                await cloudSet('matches', docId, { roomId, roomPass, roomNote });
                const idx = (CACHE.matches || []).findIndex(x => String(x.id) === String(m.id));
                if (idx >= 0) {
                    CACHE.matches[idx].roomId = roomId;
                    CACHE.matches[idx].roomPass = roomPass;
                    CACHE.matches[idx].roomNote = roomNote;
                }
                closeModal();
                toast('Room details saved!');
                loadAdmin('matches');
            }
        }
    ]);
}


function adminViewPlayers(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    const joins = (CACHE.joins || []).filter(j => String(j.matchId) === String(matchId));
    const users = CACHE.users || [];
    const groups = (match && Array.isArray(match.groups) && match.groups.length)
        ? match.groups.slice()
        : ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G'];
    const isPoint = match && String(match.category) === 'pro-qualified';

    if (joins.length === 0) {
        let empty = '<p style="text-align:center;color:#636e72;">এখনো কোনো প্লেয়ার জয়েন করেনি</p>';
        if (isPoint) {
            empty += '<p style="font-size:12px;color:#8b93a7;margin-top:10px;">Groups: ' + groups.join(', ') + '</p>';
            empty += '<button class="btn-sm edit" style="margin-top:8px;" onclick="adminEditMatchGroups(\'' + matchId + '\')">Edit Groups</button>';
        }
        showModal('Joined Players', empty, [
            { text: 'Close', class: 'btn-sm', action: closeModal }
        ]);
        return;
    }

    const sorted = joins.slice().sort((a, b) => String(a.group || '').localeCompare(String(b.group || '')));
    const list = sorted.map((j, index) => {
        const u = users.find(x => String(x.id) === String(j.userId));
        const teamOnly = j.teamName || j.inGameName || j.player1 || 'No Name';
        const iglOnly = j.iglName || '';
        let name = teamOnly;
        if (iglOnly) name += ' (IGL: ' + iglOnly + ')';
        const teamCopyAttr = String(teamOnly).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const iglCopyAttr = String(iglOnly).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const refunded = j.refunded ? '<span style="color:#e17055;font-size:11px;">REFUNDED</span>' : '';
        const grp = j.group || '—';
        const groupOpts = groups.map(g =>
            '<option value="' + String(g).replace(/"/g, '&quot;') + '"' +
            (String(g) === String(j.group) ? ' selected' : '') + '>' + g + '</option>'
        ).join('');
        // Other Qualified matches for cross-match transfer
        const otherQMatches = (CACHE.matches || []).filter(m =>
            String(m.category) === 'pro-qualified' && isActiveMatch(m)
        );
        const matchOpts = otherQMatches.map(m => {
            const filled = getJoinedCount(m.id);
            const maxP = m.maxPlayers || 48;
            const label = ((m.title || 'Match') + ' · ' + filled + '/' + maxP).replace(/</g, '');
            return '<option value="' + m.id + '"' +
                (String(m.id) === String(matchId) ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
        // groups of selected match - default current match groups; transfer will read target's groups from select if we list all unique
        const allGroupsSet = {};
        otherQMatches.forEach(m => {
            (Array.isArray(m.groups) ? m.groups : []).forEach(g => { allGroupsSet[g] = true; });
        });
        groups.forEach(g => { allGroupsSet[g] = true; });
        const allGrpList = Object.keys(allGroupsSet).length ? Object.keys(allGroupsSet) : groups;
        const xferGrpOpts = allGrpList.map(g =>
            '<option value="' + String(g).replace(/"/g, '&quot;') + '"' +
            (String(g) === String(j.group) ? ' selected' : '') + '>' + g + '</option>'
        ).join('');
        // Group / transfer UI only for Qualified Tournament
        const moveUi = !isPoint ? '' : (
            '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<span style="font-size:11px;color:#00d68f;">Group:</span>' +
            '<select id="move-grp-' + j.id + '" style="flex:1;min-width:100px;padding:6px;border-radius:8px;background:#101828;color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">' +
            groupOpts +
            '</select>' +
            '<button class="btn-sm edit" onclick="adminMoveJoinGroup(\'' + j.id + '\')">Move</button>' +
            '</div>' +
            '<div style="margin-top:8px;padding:8px;border-radius:10px;background:rgba(26,92,255,0.1);border:1px solid rgba(26,92,255,0.25);">' +
            '<div style="font-size:11px;color:#7eb0ff;font-weight:700;margin-bottom:6px;">ম্যাচ ট্রান্সফার (Qualified)</div>' +
            '<select id="xfer-match-' + j.id + '" style="width:100%;padding:6px;border-radius:8px;background:#101828;color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);margin-bottom:6px;">' +
            matchOpts +
            '</select>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
            '<select id="xfer-grp-' + j.id + '" style="flex:1;padding:6px;border-radius:8px;background:#101828;color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">' +
            xferGrpOpts +
            '</select>' +
            '<button class="btn-sm approve" onclick="adminTransferJoinMatch(\'' + j.id + '\')">Transfer</button>' +
            '</div></div>'
        );
        return (
            '<div style="background:rgba(255,255,255,0.04);padding:12px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.08);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
            '<strong style="color:#7eb0ff;">#' + (index + 1) + ' ' + name + '</strong>' +
            '<span style="font-size:12px;color:#8b93a7;">' + (j.entryFee || 0) + ' TK ' + refunded + '</span></div>' +
            '<div style="font-size:12px;color:#8b93a7;margin-top:4px;">' +
            (isPoint ? ('<span style="color:#fdcb6e;">Group: ' + grp + '</span> | ') : '') + 'User: ' + (u ? u.username : 'Unknown') +
            (j.whatsapp ? (' | WA: ' + j.whatsapp) : '') +
            '<br>Joined: ' + formatTime(j.joinedAt) +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center;">' +
            '<button type="button" class="btn-sm" style="background:#1a5cff;color:#fff;padding:6px 10px;font-size:11px;" data-copy="' + teamCopyAttr + '" data-label="Team Name" onclick="copyRoomField(this.getAttribute(\'data-copy\')||\'\',\'Team Name\')">📋 Team</button>' +
            (iglOnly
                ? ('<button type="button" class="btn-sm" style="background:#6c5ce7;color:#fff;padding:6px 10px;font-size:11px;" data-copy="' + iglCopyAttr + '" data-label="IGL" onclick="copyRoomField(this.getAttribute(\'data-copy\')||\'\',\'IGL Name\')">📋 IGL</button>')
                : '') +
            '</div>' + moveUi +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">' +
            '<button class="btn-sm edit" onclick="adminEditJoinName(\'' + j.id + '\')">Edit Name</button>' +
            (!j.refunded ? '<button class="btn-sm" style="background:#e17055;color:#fff;" onclick="adminRefundJoin(\'' + j.id + '\')">Refund</button>' : '') +
            '<button class="btn-sm delete" onclick="adminRemoveJoinOnly(\'' + j.id + '\')">Remove (no refund)</button>' +
            '<button class="btn-sm approve" onclick="adminAddBalance(' + j.userId + ')">+ Balance</button>' +
            '</div></div>'
        );
    }).join('');

    const headerBtns = isPoint
        ? '<button class="btn-sm edit" style="margin-bottom:10px;" onclick="adminEditMatchGroups(\'' + matchId + '\')">Edit Groups (A/B/C/D...)</button>'
        : '';
    showModal('Joined Players (' + joins.length + ')', headerBtns + list, [
        { text: 'Close', class: 'btn-sm', action: closeModal }
    ]);
}

async function adminMoveJoinGroup(joinId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
    if (!j) return toast('Join পাওয়া যায়নি');
    const sel = document.getElementById('move-grp-' + joinId);
    const newGroup = (sel && sel.value) ? sel.value.trim() : '';
    if (!newGroup) return toast('Group সিলেক্ট করুন');
    try {
        const delId = j._docId != null ? j._docId : j.id;
        await cloudSet('joins', delId, { group: newGroup });
        j.group = newGroup;
        toast('Group → ' + newGroup);
        adminViewPlayers(j.matchId);
    } catch (e) {
        console.error(e);
        toast('Move ব্যর্থ');
    }
}

/** Transfer team from one Qualified match to another (or same match different group). Full match → popup block. */
async function adminTransferJoinMatch(joinId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
    if (!j) return toast('Join পাওয়া যায়নি');
    const selMatch = document.getElementById('xfer-match-' + joinId);
    const selGrp = document.getElementById('xfer-grp-' + joinId);
    const targetMatchId = selMatch ? String(selMatch.value || '') : '';
    if (!targetMatchId) return toast('টার্গেট ম্যাচ সিলেক্ট করুন');
    const target = (CACHE.matches || []).find(m => String(m.id) === targetMatchId);
    if (!target) return toast('ম্যাচ পাওয়া যায়নি');
    const targetGroup = (selGrp && selGrp.value) ? selGrp.value.trim() : (j.group || '');
    const slots = getJoinSlotCount(j) || 1;
    // same match: only change group
    if (String(target.id) === String(j.matchId)) {
        try {
            const delId = j._docId != null ? j._docId : j.id;
            await cloudSet('joins', delId, { group: targetGroup });
            j.group = targetGroup;
            toast('Group → ' + (targetGroup || '—'));
            adminViewPlayers(j.matchId);
        } catch (e) {
            console.error(e);
            toast('ট্রান্সফার ব্যর্থ');
        }
        return;
    }
    // capacity check on target match
    const filled = getJoinedCount(target.id);
    const maxP = target.maxPlayers || 48;
    if (filled + slots > maxP) {
        showModal('ট্রান্সফার ব্যর্থ', `
            <div style="text-align:center;padding:12px 8px;">
                <div style="font-size:40px;margin-bottom:8px;">🚫</div>
                <p style="font-size:15px;font-weight:700;color:#ff6b6b;margin-bottom:8px;">ম্যাচটি ফুল হওয়ার কারণে ট্রান্সফার করা যাচ্ছে না</p>
                <p style="font-size:13px;color:#8b93a7;">টার্গেট ম্যাচ: ${(target.title || '').replace(/</g,'')}<br>Slots: ${filled}/${maxP} · দরকার: ${slots}</p>
            </div>
        `, [{ text: 'OK', class: 'btn-primary', action: closeModal }]);
        return;
    }
    // already joined that match?
    if ((CACHE.joins || []).some(x => String(x.matchId) === String(target.id) && String(x.userId) === String(j.userId) && !x.refunded && String(x.id) !== String(j.id))) {
        return toast('এই ইউজার ইতিমধ্যে টার্গেট ম্যাচে জয়েন আছে');
    }
    try {
        const fromMatchId = j.matchId;
        // If target match has a single group defined, prefer that group
        let finalGroup = targetGroup;
        if (Array.isArray(target.groups) && target.groups.length === 1) {
            finalGroup = target.groups[0];
        } else if (!finalGroup && Array.isArray(target.groups) && target.groups.length) {
            finalGroup = target.groups[0];
        }
        const delId = j._docId != null ? j._docId : j.id;
        // One join document moves: A loses slot, B gains join automatically
        await cloudSet('joins', delId, { matchId: target.id, group: finalGroup || '' });
        j.matchId = target.id;
        j.group = finalGroup || '';
        toast('ট্রান্সফার সফল! পুরনো ম্যাচে স্লট খালি · নতুন ম্যাচে জয়েন' + (finalGroup ? (' · ' + finalGroup) : ''));
        // Refresh lists so counts update (1/48 → 0/48 on A, 0/48 → 1/48 on B)
        try {
            if (typeof currentCategory !== 'undefined' && currentCategory) renderMatches(currentCategory);
        } catch (e) {}
        adminViewPlayers(target.id);
    } catch (e) {
        console.error(e);
        toast('ট্রান্সফার ব্যর্থ');
    }
}


function adminEditVersusMatch(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('ম্যাচ পাওয়া যায়নি');
    if (String(m.category) !== 'pro-versus') return toast('শুধু Versus ম্যাচ');
    let startVal = '';
    try {
        const d = new Date(m.startTime);
        if (!isNaN(d.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            startVal = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
    } catch (e) {}
    showModal('Edit Versus Match', `
        <div class="form-group"><label>Team A Name</label>
            <input type="text" id="ev-team-a-name" value="${String(m.teamAName || 'Team A').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Team A Logo URL</label>
            <input type="url" id="ev-team-a-logo" value="${String(m.teamALogo || '').replace(/"/g, '&quot;')}" placeholder="https://...png"></div>
        <div class="form-group"><label>Team B Name</label>
            <input type="text" id="ev-team-b-name" value="${String(m.teamBName || 'Team B').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Team B Logo URL</label>
            <input type="url" id="ev-team-b-logo" value="${String(m.teamBLogo || '').replace(/"/g, '&quot;')}" placeholder="https://...png"></div>
        <div class="form-group"><label>Title</label>
            <input type="text" id="ev-title" value="${String(m.title || '').replace(/"/g, '&quot;')}"></div>
        <div class="form-group"><label>Start Time</label>
            <input type="datetime-local" id="ev-start" value="${startVal}"></div>
        <div class="form-group"><label>Win Prize (TK)</label>
            <input type="number" id="ev-winprize" value="${m.winPrize || 0}"></div>
        <div class="form-group"><label>Entry Fee (TK)</label>
            <input type="number" id="ev-entryfee" value="${m.entryFee || 0}"></div>
        <div class="form-group"><label>Max Players / Slots</label>
            <input type="number" id="ev-maxplayers" value="${m.maxPlayers || 48}"></div>
    `, [
        { text: 'Cancel', class: 'btn-secondary', action: closeModal },
        { text: 'Save', class: 'btn-primary', action: async () => {
            const teamAName = ($('#ev-team-a-name')?.value || '').trim() || 'Team A';
            const teamBName = ($('#ev-team-b-name')?.value || '').trim() || 'Team B';
            const teamALogo = ($('#ev-team-a-logo')?.value || '').trim();
            const teamBLogo = ($('#ev-team-b-logo')?.value || '').trim();
            const title = ($('#ev-title')?.value || '').trim() || m.title;
            const startRaw = $('#ev-start')?.value;
            const winPrize = parseInt($('#ev-winprize')?.value, 10) || 0;
            const entryFee = parseInt($('#ev-entryfee')?.value, 10) || 0;
            const maxPlayers = parseInt($('#ev-maxplayers')?.value, 10) || 48;
            let startTime = m.startTime;
            if (startRaw) {
                const d = new Date(startRaw);
                if (!isNaN(d.getTime())) startTime = d.toISOString();
            }
            try {
                const docId = m._docId != null ? m._docId : m.id;
                await cloudSet('matches', docId, {
                    teamAName, teamBName, teamALogo, teamBLogo,
                    title, startTime, winPrize, entryFee, maxPlayers
                });
                Object.assign(m, { teamAName, teamBName, teamALogo, teamBLogo, title, startTime, winPrize, entryFee, maxPlayers });
                toast('Versus আপডেট হয়েছে');
                closeModal();
                if (typeof renderAdminMatches === 'function') {
                    const c = document.getElementById('admin-content') || document.querySelector('.admin-content');
                    // re-render admin matches tab if visible
                    const panel = document.getElementById('admin-matches') || document.getElementById('admin-tab-matches');
                }
                // force admin list refresh
                const matchesTab = document.querySelector('[data-admin-tab="matches"], .admin-tab.active');
                try { renderAdminPanel && renderAdminPanel(); } catch (e) {}
                try {
                    const cont = document.querySelector('#admin-page .admin-body') || document.querySelector('#admin-content');
                    if (cont && typeof renderAdminMatches === 'function') renderAdminMatches(cont);
                } catch (e) {}
            } catch (e) {
                console.error(e);
                toast('সেভ ব্যর্থ');
            }
        }}
    ]);
}

function adminEditMatchGroups(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    const groups = Array.isArray(match.groups) && match.groups.length
        ? match.groups.join(', ')
        : 'Group A, Group B, Group C, Group D, Group E, Group F, Group G';
    showModal('Edit Groups', `
        <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;">কমা দিয়ে গ্রুপ লিখুন — যেমন: Group A, Group B, Group C, Group D</p>
        <div class="form-group">
            <label>Groups</label>
            <textarea id="am-groups-edit" rows="3" style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">${String(groups).replace(/</g, '')}</textarea>
        </div>
    `, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Save Groups', class: 'btn-primary', action: async () => {
                const raw = ($('#am-groups-edit')?.value || '').trim();
                const list = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
                if (!list.length) return toast('অন্তত একটা গ্রুপ দিন');
                try {
                    await cloudSet('matches', match.id, { groups: list });
                    match.groups = list;
                    toast('Groups সেভ: ' + list.join(', '));
                    closeModal();
                    adminViewPlayers(matchId);
                } catch (e) {
                    console.error(e);
                    toast('সেভ ব্যর্থ');
                }
            }
        }
    ]);
}

function adminEditJoinName(joinId) {
    const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
    if (!j) return toast('Join not found');
    const isRoles = !!(j.roles && (j.roles.rusher || j.roles.sniper));
    const isDuo = !!(j.player2 || j.type === 'Duo');
    let body = '';
    if (j.teamName || (j.roles && j.roles.igl) || (j.roles && j.roles.whatsapp)) {
        body =
            '<div class="form-group"><label>Team Name</label><input type="text" id="en-team" value="' + (j.teamName || '') + '"></div>' +
            '<div class="form-group"><label>IGL Name</label><input type="text" id="en-igl" value="' + (j.iglName || (j.roles && j.roles.igl) || j.player1 || '') + '"></div>' +
            '<div class="form-group"><label>WhatsApp</label><input type="text" id="en-wa" value="' + (j.whatsapp || (j.roles && j.roles.whatsapp) || '') + '"></div>';
    } else if (isRoles) {
        const r = j.roles || {};
        body =
            '<div class="form-group"><label>Rusher</label><input type="text" id="en-rusher" value="' + (r.rusher || '') + '"></div>' +
            '<div class="form-group"><label>Second Rusher + Supporter</label><input type="text" id="en-second" value="' + (r.second || '') + '"></div>' +
            '<div class="form-group"><label>Bomber</label><input type="text" id="en-bomber" value="' + (r.bomber || '') + '"></div>' +
            '<div class="form-group"><label>Sniper</label><input type="text" id="en-sniper" value="' + (r.sniper || '') + '"></div>';
    } else if (isDuo) {
        body =
            '<div class="form-group"><label>Player 1</label><input type="text" id="en-p1" value="' + (j.player1 || j.inGameName || '') + '"></div>' +
            '<div class="form-group"><label>Player 2</label><input type="text" id="en-p2" value="' + (j.player2 || '') + '"></div>';
    } else {
        body = '<div class="form-group"><label>In-Game Name</label><input type="text" id="en-name" value="' + (j.inGameName || j.player1 || '') + '"></div>';
    }
    showModal('Edit Player Name', body, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Save', class: 'btn-primary', action: async () => {
                const updates = {};
                if (j.teamName || (j.roles && j.roles.igl) || $('#en-team')) {
                    const tn = ($('#en-team') && $('#en-team').value || '').trim();
                    const ig = ($('#en-igl') && $('#en-igl').value || '').trim();
                    const wa = ($('#en-wa') && $('#en-wa').value || '').trim();
                    if (tn) updates.teamName = tn;
                    if (ig) { updates.iglName = ig; updates.player1 = ig; }
                    if (wa) updates.whatsapp = wa;
                    updates.roles = { igl: ig, whatsapp: wa };
                    updates.inGameName = '[' + (tn || j.teamName || 'Team') + '] IGL: ' + (ig || '');
                } else if (isRoles) {
                    updates.roles = {
                        rusher: ($('#en-rusher') && $('#en-rusher').value || '').trim(),
                        second: ($('#en-second') && $('#en-second').value || '').trim(),
                        bomber: ($('#en-bomber') && $('#en-bomber').value || '').trim(),
                        sniper: ($('#en-sniper') && $('#en-sniper').value || '').trim()
                    };
                    updates.inGameName = [updates.roles.rusher, updates.roles.second, updates.roles.bomber, updates.roles.sniper].filter(Boolean).join(' · ');
                } else if (isDuo) {
                    updates.player1 = ($('#en-p1') && $('#en-p1').value || '').trim();
                    updates.player2 = ($('#en-p2') && $('#en-p2').value || '').trim();
                    updates.inGameName = updates.player1 + (updates.player2 ? ' + ' + updates.player2 : '');
                } else {
                    updates.inGameName = ($('#en-name') && $('#en-name').value || '').trim();
                    updates.player1 = updates.inGameName;
                }
                if (!updates.inGameName) return toast('Name required');
                Object.assign(j, updates);
                await cloudSet('joins', j.id, updates);
                closeModal();
                toast('Name updated');
                adminViewPlayers(j.matchId);
            }
        }
    ]);
}

async function adminRefundJoin(joinId) {
    const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
    if (!j) return toast('Join not found');
    if (j.refunded) return toast('Already refunded');
    const fee = Number(j.entryFee) || 0;
    if (!confirm('Refund this join? ' + fee + ' TK will be returned.')) return;
    if (_adminBalBusy) return toast('Please wait...');
    _adminBalBusy = true;
    try {
        if (fee > 0) {
            const u = await cloudGetDoc('users', j.userId);
            if (u) {
                const newBal = (u.balance || 0) + fee;
                await cloudSet('users', u.id, { balance: newBal });
                const cu = CACHE.users.find(x => String(x.id) === String(j.userId));
                if (cu) cu.balance = newBal;
                const tx = {
                    id: generateId(),
                    userId: j.userId,
                    type: 'refund',
                    amount: fee,
                    status: 'approved',
                    note: 'Single join refund (match ' + j.matchId + ')',
                    matchId: j.matchId,
                    createdAt: new Date().toISOString()
                };
                await cloudSet('transactions', tx.id, tx);
                cachePushUnique('transactions', tx);
            }
        }
        j.refunded = true;
        await cloudSet('joins', j.id, { refunded: true });
        toast('Refund done');
        adminViewPlayers(j.matchId);
    } catch (e) {
        console.error(e);
        toast('Refund failed');
    } finally {
        _adminBalBusy = false;
    }
}

function adminOpenPlayerPrizeFromResult(resultId) {
    const r = (CACHE.matchResults || []).find(x => String(x.id) === String(resultId));
    if (!r) return toast('Result not found');
    if (r.isProLeague || isProLeagueCategory(r.category)) {
        return toast('Pro League-এ প্লেয়ার প্রাইজ নয় — Team Prize ব্যবহার করুন (Edit / Team Prize)');
    }
    const matchId = r.matchId != null ? r.matchId : r.id;
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) {
        return toast('ম্যাচ আর নেই — প্লেয়ার প্রাইজ দিতে ম্যাচ থাকতে হবে। Team/Info Edit করতে পারেন।');
    }
    adminOpenResults(matchId);
}

function adminOpenResults(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('Match not found — ম্যাচ ডিলিট হয়ে থাকতে পারে');
    if (isProLeagueCategory(match.category)) {
        return toast('Pro League: প্লেয়ার প্রাইজ নয়। Result Dist → Edit / Team Prize ব্যবহার করুন।');
    }
    const joins = (CACHE.joins || []).filter(j => String(j.matchId) === String(matchId) && !j.refunded);
    const users = CACHE.users || [];
    const perKill = Number(match.perKill) || 0;
    const prizes = match.prizes || {};

    if (!joins.length) {
        showModal('Results', '<p style="text-align:center;color:#8b93a7;">No active joins</p>', [
            { text: 'Close', class: 'btn-sm', action: closeModal }
        ]);
        return;
    }

    const rows = joins.map(function(j) {
        const u = users.find(x => String(x.id) === String(j.userId));
        let name = j.inGameName || j.player1 || '—';
        if (j.roles) {
            const r = j.roles;
            name = [r.rusher, r.second, r.bomber, r.sniper].filter(Boolean).join(' · ') || name;
        } else if (j.player2) name = (j.player1 || '') + ' + ' + j.player2;
        const paid = j.prizePaid ? ('<span style="color:#00d68f;font-size:11px;">PAID ' + (j.prizeAmount || 0) + ' TK</span>') : '';
        return (
            '<div style="background:rgba(255,255,255,0.04);padding:10px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.08);">' +
            '<div style="font-size:13px;color:#e8ecf8;margin-bottom:6px;"><strong>' + name + '</strong>' +
            '<span style="color:#8b93a7;font-size:11px;"> · ' + (u ? u.username : '?') + '</span> ' + paid + '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<div class="form-group" style="flex:1;min-width:90px;margin:0;"><label style="font-size:11px;">Kills</label>' +
            '<input type="number" id="res-kills-' + j.id + '" min="0" value="' + (j.kills != null ? j.kills : 0) + '" style="width:100%;"></div>' +
            '<div class="form-group" style="flex:1;min-width:90px;margin:0;"><label style="font-size:11px;">Position (1–48)</label>' +
            '<input type="number" id="res-pos-' + j.id + '" min="0" max="48" value="' + (j.position != null ? j.position : 0) + '" style="width:100%;" placeholder="0 = none"></div>' +
            '</div></div>'
        );
    }).join('');

    let prizeInfo = formatPrizeList(prizes, match.winPrize, 48);
    if (!prizeInfo) prizeInfo = 'Win Prize: ' + (match.winPrize || 0) + ' TK';

    const isPro = isProLeagueCategory(match.category);
    showModal(isPro ? 'Pro League — Player Prize' : 'Winner Result / Prize',
        '<p style="font-size:12px;color:#8b93a7;margin-bottom:8px;">Per Kill: <strong style="color:#00d68f;">' + perKill + ' TK</strong><br>' + prizeInfo + '</p>' +
        '<p style="font-size:12px;color:#c5cbe0;margin-bottom:10px;line-height:1.5;">' +
        (isPro
            ? 'Pro League: চাইলে প্লেয়ার পজিশন/কিল দিন। টিম প্রাইজ <strong>Result Dist</strong> থেকে আলাদা সেট করুন।'
            : 'নরমাল ম্যাচ: যতজন জয়েন করেছে সবাই নিচে আছে। প্রত্যেকের <strong>Position (১–৪৮)</strong> ও Kills দিয়ে Winner Prize দিন।') +
        '</p>' +
        '<div style="max-height:50vh;overflow-y:auto;">' + rows + '</div>',
        [
            { text: 'Cancel', class: 'btn-sm', action: closeModal },
            {
                text: 'Distribute Prizes', class: 'btn-sm approve', action: async () => {
                    if (_adminBalBusy) return toast('Please wait...');
                    _adminBalBusy = true;
                    try {
                        let paidCount = 0;
                        for (const j of joins) {
                            if (j.prizePaid) continue;
                            const killsEl = document.getElementById('res-kills-' + j.id);
                            const posEl = document.getElementById('res-pos-' + j.id);
                            const kills = parseInt(killsEl && killsEl.value) || 0;
                            const pos = parseInt(posEl && posEl.value) || 0;
                            let placePrize = 0;
                            if (pos >= 1 && pos <= 48) {
                                placePrize = getPrizeByPosition(prizes, pos, match.winPrize);
                            }
                            const killPrize = kills * perKill;
                            const total = placePrize + killPrize;
                            j.kills = kills;
                            j.position = pos;
                            await cloudSet('joins', j.id, { kills: kills, position: pos });
                            if (total <= 0) continue;
                            const u = await cloudGetDoc('users', j.userId);
                            if (!u) continue;
                            const newBal = (u.balance || 0) + total;
                            const newWinBal = getWinningBalance(u) + total;
                            const addWin = placePrize > 0 ? 1 : 0;
                            const newPrize = (Number(u.totalPrizeEarned) || 0) + total;
                            const newWins = (Number(u.totalWins) || 0) + addWin;
                            await cloudSet('users', u.id, { balance: newBal, winningBalance: newWinBal, totalPrizeEarned: newPrize, totalWins: newWins });
                            const cu = CACHE.users.find(x => String(x.id) === String(j.userId));
                            if (cu) {
                                cu.balance = newBal;
                                cu.winningBalance = newWinBal;
                                cu.totalPrizeEarned = newPrize;
                                cu.totalWins = newWins;
                            }
                            if (currentUser && String(currentUser.id) === String(j.userId)) {
                                currentUser.balance = newBal;
                                currentUser.winningBalance = newWinBal;
                                currentUser.totalPrizeEarned = newPrize;
                                currentUser.totalWins = newWins;
                            }
                            const tx = {
                                id: generateId(),
                                userId: j.userId,
                                type: 'prize',
                                amount: total,
                                status: 'approved',
                                note: 'Prize: pos ' + (pos || '-') + ' + ' + kills + ' kills (' + (match.title || matchId) + ')',
                                matchId: matchId,
                                createdAt: new Date().toISOString()
                            };
                            await cloudSet('transactions', tx.id, tx);
                            cachePushUnique('transactions', tx);
                            j.prizePaid = true;
                            j.prizeAmount = total;
                            await cloudSet('joins', j.id, { prizePaid: true, prizeAmount: total, kills: kills, position: pos });
                            paidCount++;
                        }
                        if (match.status !== 'completed') {
                            match.status = 'completed';
                            await cloudSet('matches', match.id, { status: 'completed' });
                        }
                        closeModal();
                        try { await syncPublicLeaderboard(); } catch (eLb) {}
                        toast('Prizes distributed (' + paidCount + ')');
                        loadAdmin('matches');
                    } catch (e) {
                        console.error(e);
                        toast('Distribute failed');
                    } finally {
                        _adminBalBusy = false;
                    }
                }
            }
        ]
    );
}


async function ensureMatchResultRecord(match, extra = {}) {
    const id = String(match.id);
    let rec = (CACHE.matchResults || []).find(r => String(r.matchId) === id || String(r.id) === id);
    // Snapshot registered players/teams for Result Dist (admin only view)
    const joinSnap = (CACHE.joins || [])
        .filter(j => String(j.matchId) === String(match.id) && !j.refunded)
        .map(j => ({
            userId: j.userId,
            username: j.username || ((CACHE.users || []).find(u => String(u.id) === String(j.userId)) || {}).username || '',
            teamName: j.teamName || '',
            iglName: j.iglName || j.player1 || '',
            whatsapp: j.whatsapp || (j.roles && j.roles.whatsapp) || '',
            player1: j.player1 || '',
            player2: j.player2 || '',
            inGameName: j.inGameName || '',
            fee: j.entryFee != null ? j.entryFee : j.fee,
            type: j.type || '',
            roles: j.roles || null
        }));
    const base = {
        id: rec ? rec.id : id,
        matchId: match.id,
        title: match.title || '',
        category: match.category || '',
        startTime: match.startTime || '',
        winPrize: match.winPrize || 0,
        perKill: match.perKill || 0,
        prizes: match.prizes || {},
        pointTableImage: match.pointTableImage || (rec && rec.pointTableImage) || '',
        championTeam: extra.championTeam != null ? extra.championTeam : (rec && rec.championTeam) || match.winner || '',
        winner: extra.championTeam != null ? extra.championTeam : (rec && rec.winner) || match.winner || '',
        teamPrizes: (rec && rec.teamPrizes) || [],
        participants: joinSnap.length ? joinSnap : ((rec && rec.participants) || []),
        public: rec ? !!rec.public : false,
        isProLeague: isProLeagueCategory(match.category),
        updatedAt: new Date().toISOString()
    };
    if (!rec) base.createdAt = new Date().toISOString();
    Object.assign(base, extra);
    // keep participants unless extra overrides
    if (!extra.participants && joinSnap.length) base.participants = joinSnap;
    await cloudSet('matchResults', base.id, base);
    const idx = (CACHE.matchResults || []).findIndex(r => String(r.id) === String(base.id));
    if (idx >= 0) CACHE.matchResults[idx] = { ...CACHE.matchResults[idx], ...base };
    else {
        if (!CACHE.matchResults) CACHE.matchResults = [];
        CACHE.matchResults.push(base);
    }
    return base;
}


async function adminCopyMatch(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    if (window._copyMatchBusy) return toast('অপেক্ষা করুন...');
    const src = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!src) return toast('Match not found');
    const body = `
        <p style="font-size:13px;color:#c5cbe0;margin-bottom:10px;line-height:1.5;">
            <strong>${src.title || 'Match'}</strong> কপি হবে। প্রাইজ, স্লট, ম্যাপ, এন্ট্রি — সব একই থাকবে।<br>
            শুধু নতুন <strong>Start Time</strong> দিন।
        </p>
        <div class="form-group">
            <label>New Start Time</label>
            <input type="datetime-local" id="copy-match-time" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.25);color:#fff;">
        </div>`;
    showModal('Copy Match', body, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Create Copy', class: 'btn-sm approve', action: async () => {
                if (window._copyMatchBusy) return;
                const val = (document.getElementById('copy-match-time')?.value) || '';
                if (!val) return toast('নতুন টাইম দিন');
                const dStart = new Date(val);
                if (isNaN(dStart.getTime())) return toast('সঠিক টাইম দিন');
                window._copyMatchBusy = true;
                try {
                    const copy = Object.assign({}, src);
                    delete copy._docId;
                    copy.id = generateId();
                    copy.startTime = dStart.toISOString();
                    copy.status = 'live';
                    copy.roomId = '';
                    copy.roomPass = '';
                    copy.roomNote = src.roomNote || '';
                    copy.winner = '';
                    copy.movedToResults = false;
                    copy.resultPublished = false;
                    copy.registrationClosed = false;
                    copy.pointTableUrl = '';
                    copy.createdAt = new Date().toISOString();
                    await cloudSet('matches', copy.id, copy);
                    if (!CACHE.matches) CACHE.matches = [];
                    if (!CACHE.matches.some(x => String(x.id) === String(copy.id))) {
                        CACHE.matches.push(copy);
                    }
                    closeModal();
                    toast('ম্যাচ কপি হয়েছে (১টা)');
                    loadAdmin('matches');
                    if (typeof updateCategoryCounts === 'function') updateCategoryCounts();
                } catch (e) {
                    console.error(e);
                    toast(e.message || 'কপি ব্যর্থ');
                } finally {
                    setTimeout(function () { window._copyMatchBusy = false; }, 2000);
                }
            }
        }
    ]);
    try {
        const d = new Date(src.startTime);
        d.setHours(d.getHours() + 1);
        setTimeout(function () {
            const el = document.getElementById('copy-match-time');
            if (el) {
                const pad = function (n) { return String(n).padStart(2, '0'); };
                el.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            }
        }, 50);
    } catch (e) {}
}


async function adminRestoreMatchFromResults(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('Match not found');
    if (!confirm('এই ম্যাচ আবার Play / Pro League-এ ফিরিয়ে আনবেন?\n(রেজাল্ট রেকর্ড থাকবে — চাইলে Result Dist থেকে আলাদা ডিলিট করুন)')) return;
    try {
        m.status = 'live';
        m.movedToResults = false;
        m.resultPublished = false;
        await cloudSet('matches', m.id, {
            status: 'live',
            movedToResults: false,
            resultPublished: false
        });
        toast('ম্যাচ আবার Play-এ এসেছে');
        loadAdmin('matches');
        updateCategoryCounts();
        if (currentCategory) renderMatches(currentCategory);
    } catch (e) {
        console.error(e);
        toast(e.message || 'রিস্টোর ব্যর্থ');
    }
}

async function adminRemoveJoinOnly(joinId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
    if (!j) return toast('Join পাওয়া যায়নি');
    if (!confirm('এই প্লেয়ারকে ম্যাচ থেকে রিমুভ করবেন?\n\nটাকা রিফান্ড হবে না — শুধু স্লট খালি হবে।')) return;
    try {
        const delId = j._docId != null ? j._docId : j.id;
        const matchId = j.matchId;
        await cloudDelete('joins', delId);
        CACHE.joins = (CACHE.joins || []).filter(x => String(x.id) !== String(j.id) && String(x._docId || '') !== String(delId));
        toast('স্লট থেকে রিমুভ হয়েছে (রিফান্ড নেই)');
        adminViewPlayers(matchId);
        if (currentCategory) renderMatches(currentCategory);
        updateCategoryCounts();
    } catch (e) {
        console.error(e);
        toast(e.message || 'রিমুভ ব্যর্থ');
    }
}

function adminCompleteMatch(matchId) {
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('Match not found');
    const isPro = isProLeagueCategory(m.category);
    const joins = (CACHE.joins || []).filter(j => String(j.matchId) === String(matchId) && !j.refunded);

    let bodyHtml = '';
    if (isPro) {
        const teams = [];
        const seen = new Set();
        joins.forEach(j => {
            const name = (j.teamName || '').trim();
            if (!name) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            teams.push({
                teamName: name,
                igl: j.iglName || j.player1 || (j.roles && j.roles.igl) || '',
                wa: j.whatsapp || (j.roles && j.roles.whatsapp) || '',
                userId: j.userId
            });
        });
        if (!teams.length) {
            bodyHtml = `
                <p style="font-size:13px;color:#ff6b6b;margin-bottom:10px;">কোনো টিম রেজিস্ট্রেশন নেই — আগে জয়েন করুন।</p>
                <p style="font-size:12px;color:#8b93a7;">Pro League: রেজাল্ট Result Dist-এ যাবে (ডিফল্টে পাবলিক নয়)।</p>`;
        } else {
            bodyHtml = `
                <p style="font-size:13px;color:#ffb84d;font-weight:600;margin-bottom:10px;">চ্যাম্পিয়ন টিম সিলেক্ট করুন</p>
                <div id="complete-team-list" style="max-height:280px;overflow-y:auto;margin-bottom:10px;">
                    ${teams.map((t, i) => `
                        <label style="display:flex;gap:10px;align-items:flex-start;padding:10px;margin-bottom:8px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);cursor:pointer;">
                            <input type="radio" name="complete-champion-team" value="${String(t.teamName).replace(/"/g, '&quot;')}" ${i === 0 ? 'checked' : ''} style="margin-top:3px;">
                            <span style="font-size:13px;line-height:1.4;">
                                <strong style="color:#f0f2f8;">${t.teamName}</strong>
                                ${t.igl ? `<span style="color:#c5cbe0;"> · IGL: ${t.igl}</span>` : ''}
                                ${t.wa ? `<span style="color:#00d68f;"> · WA: ${t.wa}</span>` : ''}
                            </span>
                        </label>
                    `).join('')}
                </div>
                <p style="font-size:12px;color:#8b93a7;line-height:1.5;">সিলেক্ট করা টিম <strong>Champion</strong> হিসেবে সেভ হবে। রেজাল্ট Result Dist-এ যাবে — Publish করলে সবাই দেখবে।</p>`;
        }
    } else {
        bodyHtml = `
            <div class="form-group">
                <label>Winner Name / Team</label>
                <input type="text" id="complete-winner" placeholder="Winner">
            </div>
            <p style="font-size:13px;color:#8b93a7;line-height:1.55;">ম্যাচ Play থেকে উঠে যাবে। Admin Result Dist থেকে পাবলিক করতে পারবেন।</p>`;
    }

    showModal(isPro ? 'Send Pro League to Results' : 'Send to Results', bodyHtml, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Send to Results', class: 'btn-sm approve', action: async () => {
                let champ = 'TBA';
                if (isPro) {
                    const sel = document.querySelector('input[name="complete-champion-team"]:checked');
                    if (!sel || !sel.value) {
                        toast('চ্যাম্পিয়ন টিম সিলেক্ট করুন');
                        return;
                    }
                    champ = sel.value.trim();
                } else {
                    champ = ($('#complete-winner')?.value || '').trim() || 'TBA';
                }
                m.status = 'completed';
                m.winner = champ;
                await cloudSet('matches', m.id, { status: 'completed', winner: champ });
                await ensureMatchResultRecord(m, {
                    championTeam: champ,
                    winner: champ,
                    public: false
                });
                closeModal();
                toast(isPro ? 'Pro League Result সেভ — Champion: ' + champ : 'Results-এ পাঠানো হয়েছে (পাবলিক নয়)');
                loadAdmin('matches');
            }
        }
    ]);
}

async function adminRefundMatch(matchId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return toast('ম্যাচ পাওয়া যায়নি');
    const joins = (CACHE.joins || []).filter(j => String(j.matchId) === String(matchId));
    if (!joins.length) return toast('কোনো জয়েন নেই — রিফান্ডের দরকার নেই');
    if (!confirm(`সব প্লেয়ারকে এন্ট্রি ফি রিফান্ড করবেন? (${joins.length} জন)\nম্যাচ cancel হবে।`)) return;
    if (_adminBalBusy) return toast('অপেক্ষা করুন...');
    _adminBalBusy = true;
    try {
        let refunded = 0;
        for (const j of joins) {
            if (j.refunded) continue;
            const fee = Number(j.entryFee) || 0;
            if (fee > 0) {
                const u = await cloudGetDoc('users', j.userId);
                if (u) {
                    const newBal = (u.balance || 0) + fee;
                    await cloudSet('users', u.id, { balance: newBal });
                    const cu = CACHE.users.find(x => String(x.id) === String(j.userId));
                    if (cu) cu.balance = newBal;
                    const tx = {
                        id: generateId(),
                        userId: j.userId,
                        type: 'refund',
                        amount: fee,
                        status: 'approved',
                        note: `Match refund: ${match.title || matchId}`,
                        matchId: matchId,
                        createdAt: new Date().toISOString()
                    };
                    await cloudSet('transactions', tx.id, tx);
                    cachePushUnique('transactions', tx);
                }
            }
            await cloudSet('joins', j.id, { refunded: true });
            j.refunded = true;
            refunded++;
        }
        await cloudSet('matches', matchId, { status: 'cancelled', refundedAt: new Date().toISOString() });
        const mm = CACHE.matches.find(m => String(m.id) === String(matchId));
        if (mm) mm.status = 'cancelled';
        toast(`রিফান্ড সম্পন্ন (${refunded} জন)`);
        loadAdmin('matches');
        if (currentCategory) renderMatches(currentCategory);
    } catch (e) {
        console.error(e);
        toast('রিফান্ড ব্যর্থ');
    } finally {
        _adminBalBusy = false;
    }
}

async function adminDeleteMatch(matchId) {
    if (!confirm('ম্যাচ ডিলিট করবেন?\n\nপরে Active থেকে সরবে।\nDeleted Matches থেকে পরে Restore করা যাবে।\nJoin গুলো সেভ থাকবে।')) return;
    try {
        const patch = {
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            prevStatus: ((CACHE.matches || []).find(x => String(x.id) === String(matchId)) || {}).status || 'live'
        };
        await cloudSet('matches', matchId, patch);
        const mm = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
        if (mm) {
            mm.status = 'deleted';
            mm.deletedAt = patch.deletedAt;
            mm.prevStatus = patch.prevStatus;
        }
        toast('ম্যাচ ডিলিট হয়েছে — Deleted Matches থেকে Restore করতে পারবেন');
        updateCategoryCounts();
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast('ডিলিট ব্যর্থ — আবার চেষ্টা করুন');
    }
}

async function adminRestoreDeletedMatch(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const m = (CACHE.matches || []).find(x => String(x.id) === String(matchId));
    if (!m) return toast('ম্যাচ পাওয়া যায়নি');
    if (String(m.status || '').toLowerCase() !== 'deleted') return toast('এই ম্যাচ ডিলিটেড নয়');
    try {
        const restoreStatus = (m.prevStatus && m.prevStatus !== 'deleted' && m.prevStatus !== 'completed')
            ? m.prevStatus
            : 'live';
        await cloudSet('matches', matchId, {
            status: restoreStatus,
            deletedAt: null,
            prevStatus: null
        });
        m.status = restoreStatus;
        m.deletedAt = null;
        m.prevStatus = null;
        toast('ম্যাচ Restore হয়েছে ✓');
        updateCategoryCounts();
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast(e.message || 'Restore ব্যর্থ');
    }
}

async function adminPermanentDeleteMatch(matchId) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    if (!confirm('স্থায়ী ডিলিট?\n\nম্যাচ + সব Join মুছে যাবে।\nএটা আর ফেরত আনা যাবে না।')) return;
    try {
        await cloudDelete('matches', matchId);
        CACHE.matches = (CACHE.matches || []).filter(m => String(m.id) !== String(matchId));

        let allJoins = CACHE.joins || [];
        if (firebaseReady) {
            try { allJoins = await cloudGetAll('joins'); } catch (e) { console.warn(e); }
        }
        const related = allJoins.filter(j => String(j.matchId) === String(matchId));
        for (const j of related) {
            const delId = j._docId != null ? j._docId : j.id;
            try { await cloudDelete('joins', delId); } catch (e) { console.warn(e); }
        }
        CACHE.joins = allJoins.filter(j => String(j.matchId) !== String(matchId));
        toast('স্থায়ীভাবে ডিলিট হয়েছে');
        updateCategoryCounts();
        loadAdmin('matches');
    } catch (e) {
        console.error(e);
        toast('ডিলিট ব্যর্থ');
    }
}


function renderAdminResultDist(container) {
    // Published results leave this panel (still visible on public Results nav)
    const resultsAll = (CACHE.matchResults || [])
        .filter(r => !r.public)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    const rdFilter = adminResultCatFilter || 'all';
    const results = rdFilter === 'all'
        ? resultsAll
        : resultsAll.filter(r => String(r.category || '') === String(rdFilter));
    const catsRd = getCategories();

    function modeLabel(r) {
        const cat = (r.category || '').toLowerCase();
        const title = (r.title || '').toLowerCase();
        if (cat.includes('champion') || title.includes('champion')) return 'Champion Rush';
        if (cat.includes('blast') || title.includes('blast')) return 'Blast';
        if (cat.includes('scrim') || title.includes('scrim')) return 'Scrim';
        if (r.isProLeague) return 'Pro League';
        return r.category || 'Match';
    }

    function participantsHtml(r) {
        const mid = r.matchId != null ? r.matchId : r.id;
        const joins = (CACHE.joins || []).filter(j =>
            String(j.matchId) === String(mid) && !j.refunded
        );
        const snap = Array.isArray(r.participants) ? r.participants : [];
        // Prefer live joins; fall back to snapshot
        const list = joins.length ? joins : snap.map((s, idx) => ({ ...s, _snap: true, id: s.id || ('snap-' + idx) }));
        if (!list.length) {
            return `<p style="font-size:12px;color:#636e72;margin-top:8px;">রেজিস্টার্ড প্লেয়ার/টিম পাওয়া যায়নি</p>`;
        }
        const rows = list.map((j, i) => {
            const key = String(r.id) + '-' + String(j.id != null ? j.id : i);
            const team = j.teamName || '';
            const igl = j.iglName || j.player1 || (j.roles && j.roles.igl) || '';
            const wa = j.whatsapp || (j.roles && j.roles.whatsapp) || '';
            const uname = j.username || '';
            const fee = j.fee != null ? j.fee : (j.entryFee != null ? j.entryFee : '');
            const posVal = j.position != null ? j.position : '';
            const prizeVal = j.prizeAmount != null ? j.prizeAmount : '';
            const paid = j.prizePaid;
            const titleLine = (r.isProLeague || team)
                ? `<span style="color:#f0f2f8;font-weight:600;">${team || 'Team'}</span>
                   <span style="color:#c5cbe0;"> · IGL: ${igl || '—'}</span>
                   <span style="color:#00d68f;"> · WA: ${wa || '—'}</span>`
                : `<span style="color:#f0f2f8;font-weight:600;">${j.inGameName || j.player1 || '—'}${j.player2 ? ' + ' + j.player2 : ''}</span>`;
            return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.07);">
                <div style="font-size:12px;line-height:1.45;margin-bottom:8px;">
                    <strong style="color:#5b9dff;">${i + 1}.</strong> ${titleLine}
                    ${uname ? `<span style="color:#8b93a7;"> · @${uname}</span>` : ''}
                    ${fee !== '' ? `<span style="color:#ffb84d;"> · Entry ${fee} TK</span>` : ''}
                    ${paid ? `<span style="color:#00d68f;font-weight:700;"> · ✓ PAID ${j.prizeAmount || 0} TK</span>` : ''}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
                    <input type="number" id="rd-pos-${key}" min="1" max="48" placeholder="Pos"
                        value="${posVal}"
                        style="width:64px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.3);color:#fff;font-size:12px;"
                        ${paid ? 'disabled' : ''}>
                    <input type="number" id="rd-prize-${key}" min="0" placeholder="Prize TK"
                        value="${prizeVal}"
                        style="width:90px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.3);color:#fff;font-size:12px;"
                        ${paid ? 'disabled' : ''}>
                    ${paid
                        ? `<span style="font-size:11px;color:#00d68f;">Paid</span>`
                        : `<button class="btn-sm approve" style="padding:8px 12px;font-size:12px;"
                            onclick="adminPayResultParticipant('${r.id}','${j.id != null ? j.id : ''}','${j.userId != null ? j.userId : ''}','${key}')">Pay Prize</button>`}
                </div>
            </div>`;
        }).join('');
        return `<div style="margin-top:10px;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);">
            <p style="font-size:12px;color:#ffb84d;font-weight:700;margin-bottom:8px;">📋 Registered (${list.length}) — Position + Prize দিন, তারপর Pay</p>
            <p style="font-size:11px;color:#8b93a7;margin-bottom:8px;">যেমন Top 1–4: Position 1/2/3/4 + Prize TK লিখে Pay চাপুন। ব্যালেন্সে টাকা যোগ হবে।</p>
            ${rows}
        </div>`;
    }

    container.innerHTML = `
        <div class="admin-section">
            <h3>🏆 Result Distribution</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:12px;line-height:1.5;">
                প্রতিটি রেজিস্টার্ড টিম/প্লেয়ারের পাশে <strong>Position</strong> ও <strong>Prize</strong> দিয়ে Pay করুন।
                Champion Rush / Blast / Scrim আলাদা কার্ড। Publish করলে এখান থেকে উঠে যাবে — Results নেভে সবাই দেখবে।
            </p>
            <div class="form-group" style="margin-bottom:12px;">
                <label>Category Filter</label>
                <select id="admin-result-cat-filter" onchange="adminResultCatFilter=this.value;renderAdminResultDist(document.getElementById('admin-content')||document.querySelector('#admin-content'));">
                    <option value="all" ${rdFilter==='all'?'selected':''}>All Match</option>
                    ${getCategoryKeys().map(k => `<option value="${k}" ${rdFilter===k?'selected':''}>${(catsRd[k]&&(catsRd[k].name||catsRd[k].title))||k}</option>`).join('')}
                </select>
            </div>
            ${results.length === 0 ? '<p style="color:#636e72;">এখনো কোনো রেজাল্ট নেই — Matches থেকে Send to Results করুন</p>' : ''}
            ${results.map(r => {
                const teams = Array.isArray(r.teamPrizes) ? r.teamPrizes : [];
                const mode = modeLabel(r);
                return `
                <div class="admin-match-item">
                    <h4>${r.title || 'Match'}
                        ${r.isProLeague ? `<small style="color:#a78bfa;"> · ${mode}</small>` : ''}
                    </h4>
                    <p style="font-size:12px;color:#8b93a7;">
                        ${r.startTime ? formatTime(r.startTime) : ''} ·
                        Champion/Winner: <strong style="color:#ffb84d;">${r.championTeam || r.winner || '—'}</strong> ·
                        ${r.public ? '<span style="color:#00d68f;">PUBLIC</span>' : '<span style="color:#e17055;">PRIVATE</span>'}
                    </p>
                    ${teams.length ? `<p style="font-size:11px;color:#c5cbe0;margin-top:4px;">Team Prizes: ${teams.map(t => (t.teamName || '?') + ' (' + (t.amount || 0) + 'TK)').join(', ')}</p>` : ''}
                    ${participantsHtml(r)}
                    <div class="admin-actions" style="flex-wrap:wrap;margin-top:10px;">
                        <button class="btn-sm edit" onclick="adminEditResultDist('${r.id}')">${r.isProLeague ? 'Edit / Team Prize' : 'Edit Winner / Info'}</button>
                        <button class="btn-sm" style="background:${r.public ? '#e17055' : '#00b894'};color:#fff;" onclick="adminToggleResultPublic('${r.id}')">
                            ${r.public ? 'Unpublish' : 'Publish Public'}
                        </button>
                        ${(!r.isProLeague && r.matchId) ? `<button class="btn-sm" style="background:#6c5ce7;color:#fff;" onclick="adminOpenPlayerPrizeFromResult('${r.id}')">Player Prize</button>` : ''}
                        ${r.matchId ? `<button class="btn-sm approve" onclick="adminRestoreMatchFromResults('${r.matchId}')">Back to Play</button>` : ''}
                        <button class="btn-sm delete" onclick="adminDeleteMatchResult('${r.id}')">Delete Result</button>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}

async function adminPayResultParticipant(resultId, joinId, userId, key) {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    if (_adminBalBusy) return toast('অপেক্ষা করুন...');
    const posEl = document.getElementById('rd-pos-' + key);
    const prizeEl = document.getElementById('rd-prize-' + key);
    const pos = parseInt(posEl && posEl.value, 10) || 0;
    const amount = parseFloat(prizeEl && prizeEl.value) || 0;
    if (pos < 1) return toast('Position দিন (1, 2, 3...)');
    if (amount <= 0) return toast('Prize TK দিন');
    if (!userId) return toast('ইউজার ID নেই — জয়েন রেকর্ড পাওয়া যায়নি');

    _adminBalBusy = true;
    try {
        const u = await cloudGetDoc('users', userId);
        if (!u) { toast('ইউজার পাওয়া যায়নি'); return; }
        const newBal = (Number(u.balance) || 0) + amount;
        const newWin = getWinningBalance(u) + amount;
        const newPrize = (Number(u.totalPrizeEarned) || 0) + amount;
        const newWins = (Number(u.totalWins) || 0) + 1;
        await cloudSet('users', u.id, { balance: newBal, winningBalance: newWin, totalPrizeEarned: newPrize, totalWins: newWins });
        const cu = (CACHE.users || []).find(x => String(x.id) === String(userId));
        if (cu) { cu.balance = newBal; cu.winningBalance = newWin; cu.totalPrizeEarned = newPrize; cu.totalWins = newWins; }
        try { await syncPublicLeaderboard(); } catch (eLb) { console.warn(eLb); }
        if (currentUser && String(currentUser.id) === String(userId)) {
            currentUser.balance = newBal;
            currentUser.winningBalance = newWin;
            currentUser.totalPrizeEarned = newPrize;
            currentUser.totalWins = newWins;
        }

        if (joinId && !String(joinId).startsWith('snap-')) {
            const j = (CACHE.joins || []).find(x => String(x.id) === String(joinId));
            if (j) {
                j.prizePaid = true;
                j.prizeAmount = amount;
                j.position = pos;
                await cloudSet('joins', j.id, { prizePaid: true, prizeAmount: amount, position: pos });
            } else {
                await cloudSet('joins', joinId, { prizePaid: true, prizeAmount: amount, position: pos });
            }
        }

        // Update result participants snapshot
        const r = (CACHE.matchResults || []).find(x => String(x.id) === String(resultId));
        if (r && Array.isArray(r.participants)) {
            const p = r.participants.find(x => String(x.userId) === String(userId) || String(x.id) === String(joinId));
            if (p) {
                p.prizePaid = true;
                p.prizeAmount = amount;
                p.position = pos;
            }
            await cloudSet('matchResults', r.id, { participants: r.participants, updatedAt: new Date().toISOString() });
        }

        // TX log
        const txId = 'tx_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
        await cloudSet('transactions', txId, {
            id: txId,
            userId: userId,
            type: 'prize',
            amount: amount,
            status: 'completed',
            note: 'Result prize Pos ' + pos + ' (Result ' + resultId + ')',
            createdAt: new Date().toISOString()
        });

        if (typeof adminPanelNotify === 'function') {
            adminPanelNotify('প্রাইজ পেইড: ' + amount + ' TK (Pos ' + pos + ')');
        }
        toast('প্রাইজ দেওয়া হয়েছে: ' + amount + ' TK');
        loadAdmin('results-dist');
    } catch (e) {
        console.error(e);
        toast('প্রাইজ দিতে সমস্যা হয়েছে');
    } finally {
        _adminBalBusy = false;
    }
}

function adminEditResultDist(resultId) {
    const r = (CACHE.matchResults || []).find(x => String(x.id) === String(resultId));
    if (!r) return toast('Result not found');
    const teams = Array.isArray(r.teamPrizes) && r.teamPrizes.length
        ? r.teamPrizes
        : [{ position: 1, teamName: r.championTeam || '', amount: r.winPrize || 0 }, { position: 2, teamName: '', amount: 0 }, { position: 3, teamName: '', amount: 0 }];
    while (teams.length < 8) teams.push({ position: teams.length + 1, teamName: '', amount: 0 });
    const rows = teams.map((t, i) => `
        <div style="display:grid;grid-template-columns:50px 1fr 90px;gap:6px;margin-bottom:8px;align-items:center;">
            <input type="number" id="tp-pos-${i}" value="${t.position || (i + 1)}" style="width:100%;" title="Pos">
            <input type="text" id="tp-name-${i}" value="${(t.teamName || '').replace(/"/g, '&quot;')}" placeholder="Team name" style="width:100%;">
            <input type="number" id="tp-amt-${i}" value="${Number(t.amount) || 0}" placeholder="TK" style="width:100%;">
        </div>
    `).join('');
    showModal('Edit Result / Team Prizes', `
        <div class="form-group">
            <label>Champion Team</label>
            <input type="text" id="rd-champion" value="${(r.championTeam || r.winner || '').replace(/"/g, '&quot;')}">
        </div>
        <p style="font-size:12px;color:#8b93a7;margin:8px 0;">Pos · Team Name · Prize (TK)</p>
        ${rows}
    `, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Save', class: 'btn-primary', action: async () => {
                const championTeam = ($('#rd-champion')?.value || '').trim();
                const teamPrizes = [];
                for (let i = 0; i < 8; i++) {
                    const teamName = ($('#tp-name-' + i)?.value || '').trim();
                    const amount = parseInt($('#tp-amt-' + i)?.value, 10) || 0;
                    const position = parseInt($('#tp-pos-' + i)?.value, 10) || (i + 1);
                    if (teamName || amount > 0) teamPrizes.push({ position, teamName, amount });
                }
                teamPrizes.sort((a, b) => (a.position || 0) - (b.position || 0));
                const updates = {
                    championTeam,
                    winner: championTeam,
                    teamPrizes,
                    updatedAt: new Date().toISOString()
                };
                Object.assign(r, updates);
                await cloudSet('matchResults', r.id, updates);
                closeModal();
                toast('Result updated');
                loadAdmin('results-dist');
            }
        }
    ]);
}

async function adminToggleResultPublic(resultId) {
    const r = (CACHE.matchResults || []).find(x => String(x.id) === String(resultId));
    if (!r) return toast('Not found');
    const next = !r.public;
    r.public = next;
    r.updatedAt = new Date().toISOString();
    await cloudSet('matchResults', r.id, { public: next, updatedAt: r.updatedAt });
    toast(next ? 'পাবলিক করা হয়েছে — Results নেভিগেশনে দেখাবে' : 'আনপাবলিশ — পাবলিক লিস্ট থেকে সরানো হয়েছে');
    loadAdmin('results-dist');
    loadResults();
}

async function adminDeleteMatchResult(resultId) {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    if (!confirm('রেজাল্ট ডিলিট করবেন? এটি মুছে গেলে আর ফিরবে না।')) return;
    if (!confirm('নিশ্চিত? আবার Confirm চাপুন — রেজাল্ট পুরোপুরি ডিলিট হবে।')) return;
    await cloudDelete('matchResults', resultId);
    CACHE.matchResults = (CACHE.matchResults || []).filter(r => String(r.id) !== String(resultId));
    toast('Result deleted');
    loadAdmin('results-dist');
    loadResults();
}

function renderAdminDeposits(container) {
    const txs = (CACHE.transactions || [])
        .filter(t => t.type === 'deposit')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const users = CACHE.users || [];
    container.innerHTML = `
        <div class="admin-section">
            <h3>💰 Add Money Requests</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:12px;line-height:1.5;">প্লেয়ার শুধু TRX পাঠায়। Approve চাপলে আপনি আসল টাকার পরিমাণ লিখবেন।</p>
            ${txs.length === 0 ? '<p style="color:#636e72;">কোনো রিকোয়েস্ট নেই</p>' : txs.map(t => {
                const u = users.find(x => String(x.id) === String(t.userId));
                const amtLabel = (t.amount && Number(t.amount) > 0) ? (t.amount + ' TK') : 'টাকা অ্যাডমিন সেট করবেন';
                return `
                <div class="admin-req-item">
                    <h4>${u ? u.username : 'User'} — ${amtLabel}</h4>
                    <p style="font-size:13px;color:#e8ecf8;font-weight:600;word-break:break-all;">
                        TRX: <span style="color:#5b9dff;">${t.trxId || '—'}</span>
                    </p>
                    <p style="font-size:12px;color:#636e72;">
                        Method: ${t.method || '—'} · ${formatTime(t.createdAt)} · <span class="tx-status ${t.status}">${t.status}</span>
                    </p>
                    ${t.status === 'pending' ? `
                    <div class="form-group" style="margin-top:8px;">
                        <label>Approve Amount (TK)</label>
                        <input type="number" id="dep-amt-${t.id}" min="10" placeholder="যে টাকা এসেছে" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.25);color:#fff;">
                    </div>
                    <div class="admin-actions">
                        <button class="btn-sm approve" onclick="adminApproveDeposit('${t.id}')">Approve</button>
                        <button class="btn-sm reject" onclick="adminRejectDeposit('${t.id}')">Reject</button>
                    </div>` : ''}
                </div>`;
            }).join('')}
        </div>`;
}

async function adminApproveDeposit(txId) {
    const txs = CACHE.transactions || [];
    const tx = txs.find(t => String(t.id) === String(txId));
    if (!tx || tx.status !== 'pending') return;

    const input = document.getElementById('dep-amt-' + txId);
    let amount = parseInt(input && input.value, 10);
    if (!amount || amount < 1) {
        const typed = prompt('এই ট্রানজেকশনে কত টাকা এসেছে? (TK)');
        amount = parseInt(typed, 10);
    }
    if (!amount || amount < 1) return toast('সঠিক টাকার পরিমাণ দিন');

    tx.status = 'approved';
    tx.amount = amount;
    await cloudSet('transactions', tx.id, { status: 'approved', amount: amount });

    const user = await cloudGetDoc('users', tx.userId);
    if (user) {
        const newBal = (user.balance || 0) + amount;
        await cloudSet('users', user.id, { balance: newBal });
        const cu = CACHE.users.find(u => String(u.id) === String(user.id));
        if (cu) cu.balance = newBal;
        if (currentUser && String(currentUser.id) === String(user.id)) {
            currentUser.balance = newBal;
            const wb = document.getElementById('wallet-balance');
            if (wb) wb.textContent = formatMoney(newBal);
            const pb = document.getElementById('profile-balance');
            if (pb) pb.textContent = formatMoney(newBal);
        }
    }
    toast('Add Money approved: ' + amount + ' TK');
    loadAdmin('deposits');
}

async function adminRejectDeposit(txId) {
    const tx = (CACHE.transactions || []).find(t => String(t.id) === String(txId));
    if (!tx || tx.status !== 'pending') return;
    tx.status = 'rejected';
    await cloudSet('transactions', tx.id, { status: 'rejected' });
    toast('Add Money rejected');
    loadAdmin('deposits');
}

function renderAdminWithdraws(container) {
    const txs = (CACHE.transactions || [])
        .filter(t => t.type === 'withdraw')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const users = CACHE.users || [];
    container.innerHTML = `
        <div class="admin-section">
            <h3>💸 Withdraw Requests</h3>
            ${txs.length === 0 ? '<p style="color:#636e72;">কোনো রিকোয়েস্ট নেই</p>' : txs.map(t => {
                const u = users.find(x => String(x.id) === String(t.userId));
                return `
                <div class="admin-req-item">
                    <h4>${u ? u.username : 'User'} — ${Math.abs(t.amount)} TK</h4>
                    <p style="font-size:12px;color:#636e72;">
                        ${t.method || '—'} → ${t.number || '—'}<br>
                        ${formatTime(t.createdAt)} | Status: <span class="tx-status ${t.status}">${t.status}</span>
                    </p>
                    ${t.status === 'pending' ? `
                    <div class="admin-actions">
                        <button class="btn-sm approve" onclick="adminApproveWithdraw(${t.id})">Approve</button>
                        <button class="btn-sm reject" onclick="adminRejectWithdraw(${t.id})">Reject</button>
                    </div>` : ''}
                </div>`;
            }).join('')}
        </div>`;
}

async function adminApproveWithdraw(txId) {
    const tx = (CACHE.transactions || []).find(t => String(t.id) === String(txId));
    if (!tx || tx.status !== 'pending') return;
    tx.status = 'approved';
    await cloudSet('transactions', tx.id, { status: 'approved' });
    toast('Withdraw approved!');
    loadAdmin('withdraws');
}

async function adminRejectWithdraw(txId) {
    const tx = (CACHE.transactions || []).find(t => String(t.id) === String(txId));
    if (!tx || tx.status !== 'pending') return;
    // Refund balance
    const user = await cloudGetDoc('users', tx.userId);
    if (user) {
        const refund = Math.abs(tx.amount);
        const newBal = (user.balance || 0) + refund;
        const newWin = getWinningBalance(user) + refund;
        await cloudSet('users', user.id, { balance: newBal, winningBalance: newWin });
        const cu = CACHE.users.find(u => String(u.id) === String(user.id));
        if (cu) { cu.balance = newBal; cu.winningBalance = newWin; }
        if (currentUser && String(currentUser.id) === String(user.id)) {
            currentUser.balance = newBal;
            currentUser.winningBalance = newWin;
        }
    }
    tx.status = 'rejected';
    await cloudSet('transactions', tx.id, { status: 'rejected' });
    toast('Withdraw rejected (balance refunded)');
    loadAdmin('withdraws');
}

function renderAdminUsers(container) {
    const q = (window._adminUserSearch || '').trim().toLowerCase();
    let users = (CACHE.users || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (q) {
        users = users.filter(u => {
            const un = String(u.username || '').toLowerCase();
            const ph = String(u.phone || '').toLowerCase();
            const em = String(u.email || '').toLowerCase();
            const nm = String(u.name || u.displayName || '').toLowerCase();
            return un.includes(q) || ph.includes(q) || em.includes(q) || nm.includes(q);
        });
    }
    container.innerHTML = `
        <div class="admin-section">
            <h3>👥 Users (${users.length}${q ? ' found' : ''})</h3>
            <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
                <input type="text" id="admin-user-search" placeholder="Username / phone / email সার্চ..."
                    value="${(window._adminUserSearch || '').replace(/"/g, '&quot;')}"
                    style="flex:1;min-width:160px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);color:#fff;font-size:14px;">
                <button type="button" class="btn-sm approve" style="padding:10px 16px;" onclick="adminSearchUsers()">Search</button>
                ${q ? `<button type="button" class="btn-sm" style="padding:10px 14px;" onclick="window._adminUserSearch='';loadAdmin('users')">Clear</button>` : ''}
                <button type="button" class="btn-sm" style="padding:10px 14px;background:#6c5ce7;color:#fff;" onclick="adminRebuildLeaderboard()">Rebuild Top Players</button>
            </div>
            ${users.length === 0 ? '<p style="color:#636e72;">কোনো ইউজার পাওয়া যায়নি</p>' : ''}
            ${users.map(u => `
                <div class="admin-req-item">
                    <h4>${u.username} ${u.isAdmin ? '👑' : ''} ${u.verified ? '<span style="color:#1d9bf0;">✓</span>' : ''} ${u.banned ? '🚫' : ''}</h4>
                    <p style="font-size:12px;color:#636e72;">
                        ${u.phone || '—'} | ${u.email || '—'}<br>
                        Balance: ${u.balance || 0} TK | Prize: ${u.totalPrizeEarned || 0} TK | Matches: ${u.matchesJoined || 0}
                    </p>
                    <div class="admin-actions">
                        <button class="btn-sm edit" onclick="adminAddBalance(${u.id})">+ Balance</button>
                        <button class="btn-sm reject" onclick="adminDeductBalance(${u.id})">- Balance</button>
                        <button class="btn-sm" style="background:#1a5cff;" onclick="adminChangeUserPassword(${u.id})">Pass</button>
                        <button class="btn-sm" style="background:${u.verified ? '#636e72' : '#1d9bf0'};color:#fff;" onclick="adminToggleVerify(${u.id})">${u.verified ? 'Unverify' : 'Verify ✓'}</button>
                        ${!u.isAdmin ? `<button class="btn-sm ${u.banned ? 'approve' : 'delete'}" onclick="adminToggleBan(${u.id})">${u.banned ? 'Unban' : 'Ban'}</button>` : ''}
                    </div>
                </div>
            `).join('')}
        </div>`;
    const inp = document.getElementById('admin-user-search');
    if (inp) {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') adminSearchUsers();
        });
    }
}

function adminSearchUsers() {
    const inp = document.getElementById('admin-user-search');
    window._adminUserSearch = (inp && inp.value) ? inp.value.trim() : '';
    loadAdmin('users');
}

async function adminToggleVerify(userId) {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    const u = (CACHE.users || []).find(x => String(x.id) === String(userId));
    if (!u) return;
    u.verified = !u.verified;
    await cloudSet('users', u.id, { verified: !!u.verified });
    if (currentUser && String(currentUser.id) === String(userId)) currentUser.verified = u.verified;
    toast(u.verified ? 'Blue Verify দেওয়া হয়েছে ✓' : 'Verify সরানো হয়েছে');
    loadAdmin('users');
}

async function adminToggleBan(userId) {
    const u = (CACHE.users || []).find(x => String(x.id) === String(userId));
    if (!u) return;
    u.banned = !u.banned;
    await cloudSet('users', u.id, { banned: u.banned });
    toast(u.banned ? 'User banned' : 'User unbanned');
    loadAdmin('users');
}

let _adminBalBusy = false;

function adminAddBalance(userId) {
    showModal('Add Balance', `
        <div class="form-group">
            <label>Amount (TK)</label>
            <input type="number" id="add-bal-amount" placeholder="Amount">
        </div>
    `, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Add', class: 'btn-sm approve', action: async () => {
                if (_adminBalBusy) return;
                const amount = parseInt($('#add-bal-amount').value);
                if (!amount || amount <= 0) return toast('সঠিক অ্যামাউন্ট দিন');
                _adminBalBusy = true;
                document.querySelectorAll('#modal-footer button').forEach(b => { b.disabled = true; });
                try {
                    const u = await cloudGetDoc('users', userId);
                    if (!u) { toast('ইউজার পাওয়া যায়নি'); return; }
                    const newBal = (u.balance || 0) + amount;
                    await cloudSet('users', u.id, { balance: newBal });
                    const cu = CACHE.users.find(x => String(x.id) === String(userId));
                    if (cu) cu.balance = newBal;
                    const tx = {
                        id: generateId(),
                        userId,
                        type: 'admin_credit',
                        amount,
                        status: 'approved',
                        note: 'Admin credit',
                        createdAt: new Date().toISOString()
                    };
                    await cloudSet('transactions', tx.id, tx);
                    if (!(CACHE.transactions || []).some(t => String(t.id) === String(tx.id))) {
                        CACHE.transactions.unshift(tx);
                    }
                    closeModal();
                    toast('Balance added!');
                    loadAdmin('users');
                } catch (e) {
                    console.error(e);
                    toast('ব্যর্থ — আবার চেষ্টা করুন');
                } finally {
                    _adminBalBusy = false;
                }
            }
        }
    ]);
}

function adminDeductBalance(userId) {
    showModal('Deduct Balance', `
        <p style="font-size:13px;color:#e17055;margin-bottom:12px;">অস্বাভাবিক কর্মকাণ্ডের জন্য ব্যালেন্স কেটে নেওয়া হবে।</p>
        <div class="form-group">
            <label>Amount to Deduct (TK)</label>
            <input type="number" id="deduct-bal-amount" placeholder="Amount">
        </div>
        <div class="form-group">
            <label>Reason</label>
            <input type="text" id="deduct-reason" placeholder="কারণ লিখুন">
        </div>
    `, [
        { text: 'Cancel', class: 'btn-sm', action: closeModal },
        {
            text: 'Deduct', class: 'btn-sm reject', action: async () => {
                if (_adminBalBusy) return;
                const amount = parseInt($('#deduct-bal-amount').value);
                const reason = $('#deduct-reason').value.trim() || 'Admin deduction';
                if (!amount || amount <= 0) return toast('সঠিক অ্যামাউন্ট দিন');
                _adminBalBusy = true;
                document.querySelectorAll('#modal-footer button').forEach(b => {
                    b.disabled = true;
                    if ((b.textContent || '').includes('Deduct')) b.textContent = 'Processing...';
                });
                try {
                    const u = await cloudGetDoc('users', userId);
                    if (!u) { toast('ইউজার পাওয়া যায়নি'); return; }
                    if ((u.balance || 0) < amount) { toast('ইউজারের পর্যাপ্ত ব্যালেন্স নেই'); return; }
                    const newBal = (u.balance || 0) - amount;
                    const newWin = Math.min(getWinningBalance(u), newBal);
                    await cloudSet('users', u.id, { balance: newBal, winningBalance: newWin });
                    const cu = CACHE.users.find(x => String(x.id) === String(userId));
                    if (cu) { cu.balance = newBal; cu.winningBalance = newWin; }
                    if (currentUser && String(currentUser.id) === String(userId)) {
                        currentUser.balance = newBal;
                        currentUser.winningBalance = newWin;
                    }
                    const tx = {
                        id: generateId(),
                        userId,
                        type: 'admin_debit',
                        amount: -amount,
                        status: 'approved',
                        note: 'Admin deduct: ' + reason,
                        createdAt: new Date().toISOString()
                    };
                    await cloudSet('transactions', tx.id, tx);
                    if (!(CACHE.transactions || []).some(t => String(t.id) === String(tx.id))) {
                        CACHE.transactions.unshift(tx);
                    }
                    closeModal();
                    toast('Balance deducted!');
                    loadAdmin('users');
                } catch (e) {
                    console.error(e);
                    toast('ব্যর্থ — আবার চেষ্টা করুন');
                } finally {
                    _adminBalBusy = false;
                }
            }
        }
    ]);
}

function renderAdminRules(container) {
    const cats = getCategories();
    const modeRules = CACHE.modeRules || {};
    const keys = getCategoryKeys();

    container.innerHTML = `
        <div class="admin-section">
            <h3>📜 Mode Rules Edit</h3>
            <div class="form-group">
                <label>Select Mode</label>
                <select id="admin-rule-mode">
                    ${keys.map(k => `<option value="${k}">${cats[k].name}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Rules for selected mode</label>
                <p style="font-size:12px;color:#636e72;margin:0 0 8px;">প্রতি লাইনে একটা নিয়ম + ইমোজি লিখুন। এন্টার দিলে নতুন লাইন থাকবে।</p>
                <textarea id="admin-rules" rows="16" style="width:100%;padding:12px;border:2px solid rgba(255,255,255,0.12);border-radius:10px;font-family:inherit;font-size:13px;line-height:1.7;white-space:pre-wrap;background:rgba(0,0,0,0.25);color:#e8ecf8;"></textarea>
            </div>
            <button class="btn-primary" onclick="adminSaveModeRules()">Save Mode Rules</button>
        </div>
        <div class="admin-section">
            <h3>➕ Add New Mode</h3>
            <div class="form-group">
                <label>Mode Key (english, no space)</label>
                <input type="text" id="new-mode-key" placeholder="e.g. cs-4v4">
            </div>
            <div class="form-group">
                <label>Display Name</label>
                <input type="text" id="new-mode-name" placeholder="e.g. CS 4V4">
            </div>
            <div class="form-group">
                <label>Title (uppercase)</label>
                <input type="text" id="new-mode-title" placeholder="e.g. CS 4V4 RULES">
            </div>
            <button class="btn-primary" onclick="adminAddMode()">Add Mode</button>
        </div>
        <div class="admin-section">
            <h3>📋 Current Modes — Edit / Thumbnail</h3>
            <p style="font-size:12px;color:#636e72;margin-bottom:8px;">নাম ভুল হলে এখান থেকে Edit করে Save করুন</p>
            <p style="font-size:12px;color:#ffb84d;margin-bottom:10px;line-height:1.5;">⚠️ freeimage.host লিংক কাজ করে না (৪০৪ ছবি দেয়)। postimages.org / imgur / imgbb ব্যবহার করুন। ভাঙা লিংক সরাতে নিচের বাটন চাপুন।</p>
            <button class="btn-sm" style="margin-bottom:14px;background:#e10600;color:#fff;" onclick="adminClearAllThumbs()">Clear All Broken Thumbnails</button>
            ${keys.map(k => `
                <div class="admin-req-item">
                    <h4>${cats[k].name} <small style="color:#999;">(${k})</small></h4>
                    ${cats[k].thumb && isUsableThumbUrl(cats[k].thumb) ? `<img src="${cats[k].thumb}" style="width:80px;height:50px;object-fit:cover;border-radius:8px;margin:6px 0;">` : (cats[k].thumb ? `<p style="font-size:11px;color:#ff6b6b;margin:6px 0;">পুরনো লিংক কাজ করছে না — নিচে ফাইল আপলোড করুন</p>` : '')}
                    <div class="form-group" style="margin-top:8px;">
                        <label>Display Name</label>
                        <input type="text" id="name-${k}" value="${(cats[k].name || '').replace(/"/g, '&quot;')}" placeholder="BR Match">
                    </div>
                    <div class="form-group">
                        <label>Title (list header)</label>
                        <input type="text" id="title-${k}" value="${(cats[k].title || '').replace(/"/g, '&quot;')}" placeholder="BR MATCHES">
                    </div>
                    <div class="form-group">
                        <label>Thumbnail — ফাইল থেকে আপলোড (সুপারিশকৃত)</label>
                        <input type="file" accept="image/*" id="thumb-file-${k}"
                            style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);"
                            onchange="adminUploadModeThumb('${k}', this)">
                        <p style="font-size:11px;color:#8b93a7;margin:6px 0 0;">Gallery থেকে ছবি সিলেক্ট করলেই সেভ হবে — বাইরের লিংক লাগবে না</p>
                    </div>
                    <div class="form-group">
                        <label>অথবা Thumbnail Image URL</label>
                        <input type="text" id="thumb-${k}" value="${(cats[k].thumb && String(cats[k].thumb).startsWith('data:')) ? '' : (cats[k].thumb || '')}" placeholder="https://postimages.org/...">
                    </div>
                    <div class="admin-actions">
                        <button class="btn-sm edit" onclick="adminSaveModeEdit('${k}')">Save Mode</button>
                        <button class="btn-sm delete" onclick="adminDeleteMode('${k}')">Delete Mode</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    const ta = $('#admin-rules');
    if (ta && keys[0]) ta.value = rulesToEditable(modeRules[keys[0]] || '');
    $('#admin-rule-mode')?.addEventListener('change', function () {
        const modeRules = CACHE.modeRules || {};
        const t = $('#admin-rules');
        if (t) t.value = rulesToEditable(modeRules[this.value] || '');
    });
}

async function adminSaveModeThumb(key) {
    return adminSaveModeEdit(key);
}

async function adminSaveModeEdit(key) {
    const cats = getCategories();
    if (!cats[key]) return toast('Mode not found');
    const name = $(`#name-${key}`)?.value.trim();
    const title = $(`#title-${key}`)?.value.trim();
    let url = $(`#thumb-${key}`)?.value.trim() || '';
    if (url && !isUsableThumbUrl(url)) {
        toast('এই ইমেজ হোস্ট কাজ করবে না (freeimage.host)। অন্য হোস্ট ব্যবহার করুন।');
        return;
    }
    if (!name) return toast('Display Name দিন');
    cats[key].name = name;
    cats[key].title = title || name.toUpperCase();
    cats[key].thumb = url;
    CACHE.categories = cats;
    await cloudSetConfig('categories', cats);
    toast('Mode saved: ' + name);
    renderPlayCategories();
    loadAdmin('rules');
}

async function adminClearAllThumbs() {
    if (!confirm('সব মোডের Thumbnail URL মুছে ফেলবেন? (নাম থাকবে, শুধু ছবির লিংক যাবে)')) return;
    const cats = getCategories();
    Object.keys(cats).forEach(k => { cats[k].thumb = ''; });
    CACHE.categories = cats;
    await cloudSetConfig('categories', cats);
    toast('সব thumbnail মুছে গেছে — এখন গ্রেডিয়েন্ট দেখাবে');
    renderPlayCategories();
    if (typeof openProLeagueHome === 'function') { /* noop */ }
    loadAdmin('rules');
}

async function adminSaveModeRules() {
    const mode = $('#admin-rule-mode').value;
    // Keep line breaks & emojis exactly as typed
    let text = ($('#admin-rules').value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{4,}/g, '\n\n\n').trimEnd();
    const modeRules = CACHE.modeRules || {};
    // Merge with latest server rules so we never wipe other modes
    let latest = {};
    try { latest = await cloudGetConfig('modeRules', null) || {}; } catch (e) { latest = {}; }
    if (typeof latest !== 'object' || !latest) latest = {};
    latest[mode] = text;
    // keep any other keys from local CACHE if server missing them
    Object.keys(modeRules).forEach(k => {
        if (k !== mode && latest[k] === undefined && modeRules[k]) latest[k] = modeRules[k];
    });
    CACHE.modeRules = latest;
    await cloudSetConfig('modeRules', latest);
    toast('Mode rules saved! লাইন ও ইমোজি ঠিকমতো সেভ হয়েছে');
}

async function adminAddMode() {
    const key = $('#new-mode-key').value.trim().toLowerCase().replace(/\s+/g, '-');
    const name = $('#new-mode-name').value.trim();
    const title = $('#new-mode-title').value.trim() || name.toUpperCase();
    if (!key || !name) return toast('Key ও Name দিন');
    const cats = getCategories();
    if (cats[key]) return toast('এই মোড আগে থেকেই আছে');
    cats[key] = {
        title,
        name,
        color: 'linear-gradient(135deg, #6c5ce7, #a29bfe)'
    };
    CACHE.categories = cats;
    await cloudSetConfig('categories', cats);
    const order = Array.isArray(CACHE.categoryOrder) ? CACHE.categoryOrder.slice() : DEFAULT_CAT_ORDER.slice();
    if (!order.includes(key)) order.push(key);
    CACHE.categoryOrder = order;
    await cloudSetConfig('categoryOrder', order);
    const modeRules = CACHE.modeRules || {};
    modeRules[key] = `<p>${name} এর নিয়মাবলী এখানে লিখুন।</p>`;
    CACHE.modeRules = modeRules;
    await cloudSetConfig('modeRules', modeRules);
    toast('নতুন মোড যোগ হয়েছে!');
    loadAdmin('rules');
    renderPlayCategories();
}

async function adminDeleteMode(key) {
    if (!confirm('এই মোড ডিলিট করবেন?')) return;
    const cats = getCategories();
    delete cats[key];
    CACHE.categories = cats;
    await cloudSetConfig('categories', cats);
    CACHE.categoryOrder = (CACHE.categoryOrder || []).filter(k => k !== key);
    await cloudSetConfig('categoryOrder', CACHE.categoryOrder);
    const modeRules = CACHE.modeRules || {};
    delete modeRules[key];
    CACHE.modeRules = modeRules;
    await cloudSetConfig('modeRules', modeRules);
    toast('Mode deleted');
    loadAdmin('rules');
    renderPlayCategories();
}


function renderAdminProLeagueControl(container) {
    ensureProLeagueCategory();
    const cats = getCategories() || {};
    const keys = (typeof PRO_LEAGUE_ORDER !== 'undefined' ? PRO_LEAGUE_ORDER : Object.keys(PRO_LEAGUE_MODES));
    container.innerHTML = `
        <div class="admin-section">
            <h3>🏆 Pro League Control</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:12px;">
                শুধু Pro League নেভিগেশনের মোড কাস্টমাইজ। থাম্বনেইল URL দিন। অর্ডার: Champion Rush → Point Rush → Scrim → Qualified।
            </p>
            ${keys.map(key => {
                const m = PRO_LEAGUE_MODES[key] || {};
                const c = cats[key] || {};
                const name = c.name || m.name || key;
                const thumb = c.thumb || '';
                return `
                <div class="admin-req-item" style="margin-bottom:12px;">
                    <div style="font-weight:700;color:#e8ecf8;margin-bottom:8px;">${name} <span style="color:#636e72;font-size:12px;">(${key})</span></div>
                    <div class="form-group">
                        <label>Display Name</label>
                        <input type="text" id="plc-name-${key}" value="${String(name).replace(/"/g, '&quot;')}">
                    </div>
                    <div class="form-group">
                        <label>Thumbnail URL</label>
                        <input type="url" id="plc-thumb-${key}" value="${String(thumb).replace(/"/g, '&quot;')}" placeholder="https://...jpg">
                    </div>
                    ${thumb ? `<img src="${thumb}" style="width:100%;max-height:80px;object-fit:cover;border-radius:8px;margin-bottom:8px;" onerror="this.style.display='none'">` : ''}
                    <button type="button" class="btn-sm edit" onclick="adminSaveProLeagueMode('${key}')">Save Mode</button>
                </div>`;
            }).join('')}
            <p style="font-size:12px;color:#8b93a7;margin-top:12px;">ম্যাচ বানাতে: Matches ট্যাব → Category: Pro League → Mode সিলেক্ট → Team A/B নাম ও লোগো URL।</p>
        </div>
    `;
}

async function adminSaveProLeagueMode(key) {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const cats = getCategories() || {};
    const m = PRO_LEAGUE_MODES[key] || {};
    if (!cats[key]) cats[key] = { title: m.title || key, name: m.name || key, color: m.color || '', thumb: '' };
    const name = ($('#plc-name-' + key)?.value || '').trim() || m.name || key;
    const thumb = ($('#plc-thumb-' + key)?.value || '').trim();
    cats[key].name = name;
    cats[key].title = (name || '').toUpperCase();
    cats[key].thumb = thumb;
    if (m.color && !cats[key].color) cats[key].color = m.color;
    CACHE.categories = cats;
    await cloudSetConfig('categories', cats);
    toast(name + ' সেভ হয়েছে');
    if (typeof adminPanelNotify === 'function') adminPanelNotify('Pro League mode saved');
    renderAdminProLeagueControl($('#admin-content'));
}

function renderAdminSettings(container) {
    const settings = CACHE.settings || {};
    const pay = settings.payments || {};
    const showPlayers = settings.showJoinedPlayers !== false;
    const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider : (settings.homeSlider || []);
    container.innerHTML = `
        <div class="admin-section">
            <h3>📊 Dashboard</h3>
            ${renderAdminDashboard()}
        </div>
        <div class="admin-section">
            <h3>⚙️ Settings</h3>
            <div class="form-group">
                <label>Telegram Support Link</label>
                <input type="text" id="set-telegram" value="${settings.supportTelegram || ''}">
            </div>
            <div class="form-group">
                <label>Home Notice Banner</label>
                <textarea id="set-notice" rows="2" style="width:100%;padding:10px;border:2px solid #dfe6e9;border-radius:10px;font-family:inherit;">${settings.notice || ''}</textarea>
            </div>
            <div class="form-group">
                <label>Entry Popup Notice</label>
                <textarea id="set-popup" rows="5" style="width:100%;padding:10px;border:2px solid #dfe6e9;border-radius:10px;font-family:inherit;" placeholder="Deposit bonus notice...">${settings.popupNotice || ''}</textarea>
            </div>
            <div class="form-group">
                <label>Tutorial: How to add money? (YouTube link)</label>
                <input type="text" id="set-tut-add" placeholder="https://youtube.com/..." value="${(settings.tutorialAddMoney || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="form-group">
                <label>Tutorial: How to join a match? (YouTube link)</label>
                <input type="text" id="set-tut-join" placeholder="https://youtube.com/..." value="${(settings.tutorialJoinMatch || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="form-group">
                <label>Tutorial: How to join in a room? (YouTube link)</label>
                <input type="text" id="set-tut-room" placeholder="https://youtube.com/..." value="${(settings.tutorialJoinRoom || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="set-show-players" ${showPlayers ? 'checked' : ''} style="width:18px;height:18px;">
                    প্লেয়াররা ম্যাচে কে জয়েন করেছে দেখতে পারবে
                </label>
            </div>
            <button class="btn-primary" onclick="adminSaveSettings()">Save Settings</button>
        </div>
        <div class="admin-section">
            <h3>📊 Poll Bot (অ্যাপে ঢোকার পপআপ)</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;line-height:1.45;">
                চালু থাকলে ইউজার অ্যাপে ঢোকার পর পোল পপআপ দেখবে। এক ইউজার একবারই ভোট দিতে পারবে, বদলানো যাবে না।
            </p>
            <div class="form-group">
                <label>প্রশ্ন</label>
                <input type="text" id="poll-q" placeholder="কি অবস্থা কেমন আছেন সবাই?" value="${(CACHE.activePoll && CACHE.activePoll.question) ? String(CACHE.activePoll.question).replace(/"/g, '&quot;') : ''}">
            </div>
            <div class="form-group">
                <label>অপশন (প্রতি লাইনে একটি)</label>
                <textarea id="poll-opts" rows="4" style="width:100%;padding:10px;border-radius:10px;border:2px solid #dfe6e9;font-family:inherit;" placeholder="ভালো\nভালো নেই">${(CACHE.activePoll && Array.isArray(CACHE.activePoll.options)) ? CACHE.activePoll.options.map(o => String(o).replace(/</g,'&lt;')).join('\n') : 'ভালো\nভালো নেই'}</textarea>
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="poll-active" ${(CACHE.activePoll && CACHE.activePoll.active) ? 'checked' : ''} style="width:18px;height:18px;">
                    <span style="font-weight:700;color:#00d68f;">পোল চালু (ইউজারদের দেখাবে)</span>
                </label>
            </div>
            ${CACHE.activePoll ? (() => {
                const counts = getPollCounts(CACHE.activePoll);
                const total = counts.reduce((a,b)=>a+b,0);
                const lines = (CACHE.activePoll.options || []).map((o,i) =>
                    `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                        <span>${String(o).replace(/</g,'&lt;')}</span>
                        <strong style="color:#5b9dff;">${counts[i]||0}</strong>
                    </div>`
                ).join('');
                return `<div style="margin:10px 0;padding:12px;border-radius:12px;background:rgba(0,0,0,0.25);">
                    <div style="font-size:12px;color:#8b93a7;margin-bottom:8px;">মোট ভোট: <strong style="color:#fff;">${total}</strong> · Status: ${CACHE.activePoll.active ? '🟢 Active' : '🔴 Closed'}</div>
                    ${lines}
                </div>`;
            })() : '<p style="font-size:12px;color:#636e72;">এখনো কোনো পোল সেভ নেই</p>'}
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
                <button class="btn-primary" type="button" onclick="adminSavePoll()">Save Poll</button>
                <button class="btn-sm delete" type="button" onclick="adminClosePoll()">পোল বন্ধ করুন</button>
            </div>
        </div>
        <div class="admin-section">
            <h3>🔒 অ্যাপ বন্ধ / চালু (Maintenance)</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;">
                বন্ধ করলে সাধারণ ইউজার লোডিংয়ের পর মেসেজ দেখবে। অ্যাডমিন আগের মতোই ঢুকতে পারবে।
            </p>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="set-app-closed" ${settings.appClosed ? 'checked' : ''} style="width:18px;height:18px;">
                    <span style="color:#ff6b6b;font-weight:700;">অ্যাপ বন্ধ করুন (ইউজারদের জন্য)</span>
                </label>
            </div>
            <div class="form-group">
                <label>ইউজারদের কাছে যে মেসেজ দেখাবে</label>
                <textarea id="set-app-closed-msg" rows="4" placeholder="এই মুহূর্তে অ্যাপটি বন্ধ আছে...">${(settings.appClosedMessage || '').replace(/</g, '&lt;')}</textarea>
                <p style="font-size:11px;color:#8b93a7;margin:6px 0 0;">খালি রাখলে ডিফল্ট মেসেজ যাবে</p>
            </div>
            <button class="btn-primary" onclick="adminSaveSettings()">Save + অন/অফ আপডেট</button>
        </div>
        <div class="admin-section">
            <h3>🧹 Cleanup (রিড কমাতে)</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;">
                যে ম্যাচ আর নেই, সেগুলোর পুরনো Join Firebase থেকে মুছে ফেলুন। Total Joins কমে যাবে।
            </p>
            <button type="button" class="btn-sm delete" style="padding:12px 18px;" onclick="adminCleanupOrphanJoins()">
                Orphan Joins মুছুন
            </button>
        </div>
        <div class="admin-section">
            <h3>🖼️ Ultimate Slider (Home)</h3>
            <p style="font-size:12px;color:#8b93a7;margin-bottom:10px;">Play পেজে ফুল-উইডথ স্লাইডার। ছবি + ঐচ্ছিক লিংক (YouTube / Telegram ইত্যাদি)।</p>
            <div class="form-group">
                <label>স্লাইড ক্লিক লিংক (ঐচ্ছিক)</label>
                <input type="text" id="slider-link" placeholder="https://youtube.com/... বা https://t.me/..."
                    style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">
                <p style="font-size:11px;color:#8b93a7;margin:6px 0 0;">স্লাইডে ক্লিক করলে এই লিংক খুলবে</p>
            </div>
            <div class="form-group">
                <label>নতুন স্লাইড ছবি (Gallery)</label>
                <input type="file" accept="image/*" id="slider-file"
                    style="width:100%;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);"
                    onchange="adminAddSliderSlide(this)">
            </div>
            <div class="form-group">
                <label>অথবা স্লাইড Image URL</label>
                <div style="display:flex;gap:8px;">
                    <input type="url" id="slider-image-url" placeholder="https://...jpg / png"
                        style="flex:1;padding:10px;border-radius:10px;background:rgba(0,0,0,0.25);color:#e8ecf8;border:1px solid rgba(255,255,255,0.12);">
                    <button type="button" class="btn-sm" style="background:#1a5cff;color:#fff;white-space:nowrap;"
                        onclick="adminAddSliderSlideFromUrl()">Add URL</button>
                </div>
                <p style="font-size:11px;color:#8b93a7;margin:6px 0 0;">URL দিলে Firebase-এ শুধু লিংক সেভ হয় (লাইটওয়েট)</p>
            </div>
            <div id="slider-admin-list">
                ${(slides || []).map((s, i) => `
                    <div class="admin-req-item">
                        <div style="display:flex;gap:10px;align-items:center;">
                            <img src="${s.image}" style="width:90px;height:48px;object-fit:cover;border-radius:8px;">
                            <div style="flex:1;font-size:12px;color:#8b93a7;word-break:break-all;">
                                Slide ${i + 1}<br>
                                ${s.link ? `<span style="color:#5b9dff;">🔗 ${s.link}</span>` : '<span style="color:#636e72;">লিংক নেই</span>'}
                            </div>
                            <button class="btn-sm delete" onclick="adminRemoveSliderSlide('${s.id}')">Delete</button>
                        </div>
                        <div class="form-group" style="margin-top:8px;">
                            <label>লিংক এডিট</label>
                            <input type="text" id="slide-link-${s.id}" value="${(s.link || '').replace(/"/g, '&quot;')}" placeholder="https://...">
                            <button class="btn-sm edit" style="margin-top:6px;" onclick="adminUpdateSliderLink('${s.id}')">Save Link</button>
                        </div>
                    </div>
                `).join('') || '<p style="color:#636e72;font-size:13px;">এখনো কোনো স্লাইড নেই</p>'}
            </div>
        </div>
        <div class="admin-section">
            <h3>🔐 Admin Password Change</h3>
            <div class="form-group">
                <label>Current Password</label>
                <input type="password" id="admin-pass-current" placeholder="বর্তমান পাসওয়ার্ড" autocomplete="current-password">
            </div>
            <div class="form-group">
                <label>New Password</label>
                <input type="password" id="admin-pass-new" placeholder="নতুন পাসওয়ার্ড (মিনিমাম ৪)" autocomplete="new-password">
            </div>
            <div class="form-group">
                <label>Confirm New Password</label>
                <input type="password" id="admin-pass-confirm" placeholder="আবার নতুন পাসওয়ার্ড" autocomplete="new-password">
            </div>
            <button class="btn-primary" onclick="adminChangeOwnPassword()">Change Admin Password</button>
        </div>
        <div class="admin-section">
            <h3>💳 Payment Numbers (Add Money)</h3>
            <div class="form-group">
                <label>bKash Number</label>
                <input type="text" id="pay-bkash" value="${pay.bKash?.number || ''}" placeholder="01XXXXXXXXX">
            </div>
            <div class="form-group">
                <label>Nagad Number</label>
                <input type="text" id="pay-nagad" value="${pay.Nagad?.number || ''}" placeholder="01XXXXXXXXX">
            </div>
            <button class="btn-primary" onclick="adminSavePayments()">Save Payment Numbers</button>
        </div>
        <div class="admin-section">
            <h3>☁️ Cloud Status</h3>
            <p style="font-size:13px;color:${firebaseReady ? '#00b894' : '#e17055'};">
                ${firebaseReady ? '✅ Firebase Connected — সব ইউজার একই ডেটা দেখবে' : '⚠️ Firebase config দেওয়া হয়নি — শুধু এই ডিভাইসে কাজ করবে'}
            </p>
        </div>
    `;
}

function renderAdminDashboard() {
    const users = CACHE.users || [];
    const matches = CACHE.matches || [];
    const txs = CACHE.transactions || [];
    const matchIds = new Set(matches.map(m => String(m.id)));
    // Only joins for matches that still exist (deleted match joins not counted)
    const joins = (CACHE.joins || []).filter(j => matchIds.has(String(j.matchId)));
    const pendingDep = txs.filter(t => t.type === 'deposit' && t.status === 'pending').length;
    const pendingWd = txs.filter(t => t.type === 'withdraw' && t.status === 'pending').length;
    const totalBal = users.reduce((s, u) => s + (u.balance || 0), 0);
    const activeMatches = matches.filter(m => isActiveMatch(m)).length;
    const card = (bg, border, numColor, num, label) => `
            <div style="background:${bg};padding:14px 10px;border-radius:12px;text-align:center;border:1px solid ${border};">
                <div style="font-size:22px;font-weight:800;color:${numColor};line-height:1.2;">${num}</div>
                <div style="font-size:11px;color:#c5cbe0;margin-top:6px;font-weight:600;">${label}</div>
            </div>`;
    return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;">
            ${card('#12182a', 'rgba(26,92,255,0.35)', '#5b9dff', users.length, 'Users')}
            ${card('#0f1a14', 'rgba(0,214,143,0.3)', '#00d68f', activeMatches, 'Active Matches')}
            ${card('#1a1210', 'rgba(225,6,0,0.35)', '#ff6b6b', pendingDep, 'Pending Add Money')}
            ${card('#1a1018', 'rgba(225,6,0,0.25)', '#ff8a80', pendingWd, 'Pending Withdraw')}
            ${card('#101828', 'rgba(26,92,255,0.3)', '#7eb0ff', joins.length, 'Total Joins')}
            ${card('#161018', 'rgba(225,6,0,0.3)', '#e10600', totalBal + ' TK', 'Total User Balance')}
        </div>
    `;
}


async function adminCleanupOrphanJoins() {
    if (!currentUser || !currentUser.isAdmin) {
        toast('শুধু অ্যাডমিন');
        return;
    }
    const ok = confirm('ম্যাচ নেই এমন সব Join মুছে যাবে।\nFirebase থেকে পুরোপুরি ডিলিট হবে। চালিয়ে যাবেন?');
    if (!ok) return;
    try {
        toast('Cleanup চলছে... অপেক্ষা করুন');
        let matches = [];
        let joins = [];
        if (firebaseReady && db) {
            const [mSnap, jSnap] = await Promise.all([
                db.collection('matches').get(),
                db.collection('joins').get()
            ]);
            matches = mSnap.docs.map(d => ({ id: d.id, ...d.data(), _docId: d.id }));
            joins = jSnap.docs.map(d => ({ id: d.id, ...d.data(), _docId: d.id }));
        } else {
            matches = await cloudGetAll('matches');
            joins = await cloudGetAll('joins');
        }
        CACHE.matches = matches;
        const matchIds = new Set(matches.map(m => String(m.id)));
        // No matches at all → every join is orphan
        const orphans = matches.length === 0
            ? joins.slice()
            : joins.filter(j => !matchIds.has(String(j.matchId)));

        if (!orphans.length) {
            CACHE.joins = joins;
            toast('কোনো অতিরিক্ত Join নেই');
            loadAdmin('settings');
            return;
        }

        let deleted = 0;
        let failed = 0;
        for (const j of orphans) {
            const delId = String(j._docId != null ? j._docId : j.id);
            try {
                if (firebaseReady && db) {
                    await db.collection('joins').doc(delId).delete();
                } else {
                    await cloudDelete('joins', delId);
                }
                deleted++;
            } catch (e) {
                failed++;
                console.warn('join delete fail', delId, e);
            }
        }
        CACHE.joins = matches.length === 0
            ? []
            : joins.filter(j => matchIds.has(String(j.matchId)));

        const msg = failed
            ? (deleted + ' মুছেছে, ' + failed + ' ব্যর্থ')
            : (deleted + ' টা Join মুছেছে');
        toast(msg);
        if (typeof adminPanelNotify === 'function') adminPanelNotify(msg);
        loadAdmin('settings');
    } catch (e) {
        console.error('Cleanup error:', e);
        toast('Cleanup ব্যর্থ: ' + (e.message || 'নেট চেক করুন'));
    }
}

async function adminSaveSettings() {
    const settings = CACHE.settings || {};
    settings.supportTelegram = $('#set-telegram').value.trim();
    settings.notice = $('#set-notice')?.value.trim() || '';
    settings.popupNotice = $('#set-popup')?.value.trim() || '';
    settings.tutorialAddMoney = $('#set-tut-add')?.value.trim() || '';
    settings.tutorialJoinMatch = $('#set-tut-join')?.value.trim() || '';
    settings.tutorialJoinRoom = $('#set-tut-room')?.value.trim() || '';
    settings.showJoinedPlayers = $('#set-show-players')?.checked !== false;
    settings.appClosed = !!$('#set-app-closed')?.checked;
    settings.appClosedMessage = $('#set-app-closed-msg')?.value.trim() || '';
    CACHE.settings = settings;
    await cloudSetConfig('settings', settings);
    toast(settings.appClosed ? 'অ্যাপ ইউজারদের জন্য বন্ধ' : 'অ্যাপ চালু — Settings saved');
    renderHomeNotice();
    applyAppLockGate();
    const shopLink = $('#shop-telegram-link');
    if (shopLink) {
        const tg = settings.supportTelegram || 'https://t.me/huntxbd';
        shopLink.href = tg;
        shopLink.target = '_blank';
        shopLink.rel = 'noopener noreferrer';
        shopLink.onclick = function (e) { e.preventDefault(); openExternalLink(tg); };
    }
}

async function adminSavePayments() {
    const settings = CACHE.settings || {};
    settings.payments = {
        bKash: { number: $('#pay-bkash').value.trim(), type: 'Personal' },
        Nagad: { number: $('#pay-nagad').value.trim(), type: 'Personal' }
    };
    CACHE.settings = settings;
    await cloudSetConfig('settings', settings);
    toast('Payment numbers saved!');
}
window.adminSavePayments = adminSavePayments;


// ==================== HOME SLIDER ====================
let _sliderTimer = null;
let _sliderIndex = 0;

async function loadHomeSlider() {
    try {
        const fromCloud = await cloudGetConfig('homeSlider', null);
        if (Array.isArray(fromCloud)) {
            CACHE.homeSlider = fromCloud;
        } else if (CACHE.settings && Array.isArray(CACHE.settings.homeSlider)) {
            CACHE.homeSlider = CACHE.settings.homeSlider;
        } else if (!Array.isArray(CACHE.homeSlider)) {
            CACHE.homeSlider = [];
        }
    } catch (e) {
        if (!Array.isArray(CACHE.homeSlider)) CACHE.homeSlider = [];
    }
    renderHomeSlider();
}

function renderHomeSlider() {
    const box = document.getElementById('home-slider');
    if (!box) return;
    const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.filter(s => s && s.image) : [];
    const chip = document.getElementById('nav-balance-chip');
    if (!slides.length) {
        box.style.display = 'none';
        box.innerHTML = '';
        if (_sliderTimer) { clearInterval(_sliderTimer); _sliderTimer = null; }
        if (chip) chip.style.display = 'none';
        return;
    }
    box.style.display = 'block';
    if (chip) chip.style.display = 'inline-flex';
    if (_sliderIndex >= slides.length) _sliderIndex = 0;

    // Build once if structure missing or slide count changed
    const needRebuild = !box.querySelector('.home-slider-track') ||
        box.querySelectorAll('.home-slider-slide').length !== slides.length;

    if (needRebuild) {
        box.innerHTML = `
            <div class="home-slider-viewport">
                <div class="home-slider-track">
                    ${slides.map((s, i) => `
                        <div class="home-slider-slide" data-i="${i}" data-link="${(s.link || '').replace(/"/g, '&quot;')}" style="${s.link ? 'cursor:pointer;' : ''}">
                            <img src="${s.image}" alt="slide" draggable="false">
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="home-slider-dots">
                ${slides.map((_, i) => `<button type="button" class="home-slider-dot" data-i="${i}" aria-label="slide ${i + 1}"></button>`).join('')}
            </div>
        `;
        box.querySelectorAll('.home-slider-dot').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                goToSlide(parseInt(btn.dataset.i, 10) || 0);
                startSliderAutoplay();
            });
        });
        box.querySelectorAll('.home-slider-slide').forEach(slideEl => {
            slideEl.addEventListener('click', (e) => {
                // ignore if it was a swipe
                if (box._swiped) { box._swiped = false; return; }
                const link = (slideEl.getAttribute('data-link') || '').trim();
                if (link) openExternalLink(link);
            });
        });
        // touch swipe
        const vp = box.querySelector('.home-slider-viewport');
        let startX = 0;
        vp.addEventListener('touchstart', e => { startX = e.touches[0].clientX; box._swiped = false; }, { passive: true });
        vp.addEventListener('touchend', e => {
            const dx = e.changedTouches[0].clientX - startX;
            if (Math.abs(dx) > 40) {
                box._swiped = true;
                if (dx < 0) goToSlide(_sliderIndex + 1);
                else goToSlide(_sliderIndex - 1);
                startSliderAutoplay();
            }
        }, { passive: true });
    }

    const track = box.querySelector('.home-slider-track');
    if (track) {
        track.style.transform = `translateX(-${_sliderIndex * 100}%)`;
    }
    box.querySelectorAll('.home-slider-dot').forEach((d, i) => {
        d.classList.toggle('active', i === _sliderIndex);
    });
    startSliderAutoplay();
}

function goToSlide(i) {
    const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.filter(s => s && s.image) : [];
    if (!slides.length) return;
    _sliderIndex = ((i % slides.length) + slides.length) % slides.length;
    const box = document.getElementById('home-slider');
    const track = box && box.querySelector('.home-slider-track');
    if (track) track.style.transform = `translateX(-${_sliderIndex * 100}%)`;
    if (box) {
        box.querySelectorAll('.home-slider-dot').forEach((d, idx) => {
            d.classList.toggle('active', idx === _sliderIndex);
        });
    }
}

function startSliderAutoplay() {
    if (_sliderTimer) clearInterval(_sliderTimer);
    const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.filter(s => s && s.image) : [];
    if (slides.length < 2) return;
    // ~3s like Khelo style auto banner
    _sliderTimer = setInterval(() => {
        goToSlide(_sliderIndex + 1);
    }, 3200);
}

async function adminAddSliderSlide(inputEl) {
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;
    try {
        toast('স্লাইড প্রসেস হচ্ছে...');
        const dataUrl = await fileToThumbDataUrl(file, 1000, 0.8);
        const link = ($('#slider-link')?.value || '').trim();
        const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.slice() : [];
        slides.push({ id: generateId(), image: dataUrl, link: link || '', createdAt: new Date().toISOString() });
        CACHE.homeSlider = slides;
        await cloudSetConfig('homeSlider', slides);
        if ($('#slider-link')) $('#slider-link').value = '';
        toast('স্লাইড যোগ হয়েছে');
        renderHomeSlider();
        loadAdmin('settings');
    } catch (e) {
        console.error(e);
        toast(e.message || 'স্লাইড আপলোড ব্যর্থ');
    } finally {
        if (inputEl) inputEl.value = '';
    }
}

async function adminAddSliderSlideFromUrl() {
    if (!currentUser?.isAdmin) return toast('শুধু অ্যাডমিন');
    const url = ($('#slider-image-url')?.value || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return toast('সঠিক Image URL দিন (https://...)');
    try {
        const link = ($('#slider-link')?.value || '').trim();
        const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.slice() : [];
        slides.push({ id: generateId(), image: url, link: link || '', createdAt: new Date().toISOString() });
        CACHE.homeSlider = slides;
        await cloudSetConfig('homeSlider', slides);
        if ($('#slider-image-url')) $('#slider-image-url').value = '';
        if ($('#slider-link')) $('#slider-link').value = '';
        toast('স্লাইড URL যোগ হয়েছে');
        renderHomeSlider();
        loadAdmin('settings');
    } catch (e) {
        console.error(e);
        toast(e.message || 'সেভ ব্যর্থ');
    }
}

async function adminUpdateSliderLink(id) {
    const link = ($(`#slide-link-${id}`)?.value || '').trim();
    const slides = Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider.slice() : [];
    const s = slides.find(x => String(x.id) === String(id));
    if (!s) return toast('Slide not found');
    s.link = link;
    CACHE.homeSlider = slides;
    await cloudSetConfig('homeSlider', slides);
    toast('স্লাইড লিংক সেভ হয়েছে');
    renderHomeSlider();
    loadAdmin('settings');
}

async function adminRemoveSliderSlide(id) {
    if (!confirm('এই স্লাইড ডিলিট করবেন?')) return;
    const slides = (Array.isArray(CACHE.homeSlider) ? CACHE.homeSlider : []).filter(s => String(s.id) !== String(id));
    CACHE.homeSlider = slides;
    await cloudSetConfig('homeSlider', slides);
    toast('স্লাইড মুছে গেছে');
    renderHomeSlider();
    loadAdmin('settings');
}

async function adminChangeOwnPassword() {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    const cur = ($('#admin-pass-current')?.value || '').trim();
    const nw = ($('#admin-pass-new')?.value || '').trim();
    const cf = ($('#admin-pass-confirm')?.value || '').trim();
    if (!cur) return toast('বর্তমান পাসওয়ার্ড দিন');
    if (cur !== currentUser.password) return toast('বর্তমান পাসওয়ার্ড ভুল');
    if (!nw || nw.length < 4) return toast('নতুন পাসওয়ার্ড অন্তত ৪ অক্ষর');
    if (nw !== cf) return toast('নতুন পাসওয়ার্ড মিলছে না');
    currentUser.password = nw;
    await cloudSet('users', currentUser.id, { password: nw });
    const cu = (CACHE.users || []).find(u => String(u.id) === String(currentUser.id));
    if (cu) cu.password = nw;
    try { localStorage.setItem('hx_user', JSON.stringify(currentUser)); } catch (e) {}
    adminPanelNotify('অ্যাডমিন পাসওয়ার্ড চেঞ্জ হয়েছে');
    toast('অ্যাডমিন পাসওয়ার্ড চেঞ্জ হয়েছে');
    if ($('#admin-pass-current')) $('#admin-pass-current').value = '';
    if ($('#admin-pass-new')) $('#admin-pass-new').value = '';
    if ($('#admin-pass-confirm')) $('#admin-pass-confirm').value = '';
}

function adminPanelNotify(msg) {
    // Small success popup only visible in admin panel area
    let box = document.getElementById('admin-panel-notify');
    if (!box) {
        box = document.createElement('div');
        box.id = 'admin-panel-notify';
        box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(0.9);z-index:99999;background:rgba(12,16,28,0.96);border:1px solid rgba(0,214,143,0.45);border-radius:14px;padding:16px 22px;color:#e8ecf8;font-size:14px;font-weight:600;box-shadow:0 12px 40px rgba(0,0,0,0.5);opacity:0;transition:all 0.25s ease;pointer-events:none;text-align:center;max-width:85vw;';
        document.body.appendChild(box);
    }
    box.innerHTML = '<div style="font-size:28px;color:#00d68f;margin-bottom:6px;">✓</div>' + msg;
    box.style.opacity = '1';
    box.style.transform = 'translate(-50%,-50%) scale(1)';
    clearTimeout(box._t);
    box._t = setTimeout(() => {
        box.style.opacity = '0';
        box.style.transform = 'translate(-50%,-50%) scale(0.9)';
    }, 1800);
}

async function adminChangeUserPassword(userId) {
    if (!currentUser || !currentUser.isAdmin) return toast('শুধু অ্যাডমিন');
    const u = (CACHE.users || []).find(x => String(x.id) === String(userId));
    if (!u) return toast('ইউজার পাওয়া যায়নি');
    showModal('Change Password — ' + (u.username || ''), `
        <p style="font-size:13px;color:#8b93a7;margin-bottom:10px;">ইউজার: <strong style="color:#e8ecf8;">${u.username}</strong></p>
        <div class="form-group">
            <label>নতুন পাসওয়ার্ড</label>
            <input type="text" id="admin-user-new-pass" placeholder="নতুন পাসওয়ার্ড (মিনিমাম ৪)" autocomplete="off">
        </div>
        <div class="form-group">
            <label>কনফার্ম পাসওয়ার্ড</label>
            <input type="text" id="admin-user-confirm-pass" placeholder="আবার লিখুন" autocomplete="off">
        </div>
    `, [
        { text: 'Cancel', class: 'btn-secondary', action: () => closeModal() },
        { text: 'Save Password', class: 'btn-primary', action: async () => {
            const nw = ($('#admin-user-new-pass')?.value || '').trim();
            const cf = ($('#admin-user-confirm-pass')?.value || '').trim();
            if (!nw || nw.length < 4) return toast('পাসওয়ার্ড অন্তত ৪ অক্ষর');
            if (nw !== cf) return toast('পাসওয়ার্ড মিলছে না');
            u.password = nw;
            await cloudSet('users', u.id, { password: nw });
            closeModal();
            adminPanelNotify('ইউজার পাসওয়ার্ড চেঞ্জ হয়েছে: ' + u.username);
            toast('পাসওয়ার্ড আপডেট হয়েছে');
            loadAdmin('users');
        }}
    ]);
}

// ==================== MODAL ====================
function showModal(title, bodyHtml, buttons = []) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    const footer = $('#modal-footer');
    footer.innerHTML = '';
    buttons.forEach(btn => {
        const b = document.createElement('button');
        b.className = btn.class || 'btn-sm';
        b.textContent = btn.text;
        const label = String(btn.text || '').toLowerCase();
        const isCancel = label.includes('cancel') || label.includes('বন্ধ') || label.includes('ঠিক আছে') || label.includes('ok') || label.includes('close');
        if (isCancel || !btn.action) {
            b.onclick = btn.action || closeModal;
        } else {
            // Fire at most once — blocks double notification / double request
            let fired = false;
            b.onclick = async (e) => {
                if (fired || b.disabled) return;
                fired = true;
                b.disabled = true;
                const prevText = b.textContent;
                try {
                    const ret = btn.action(e);
                    if (ret && typeof ret.then === 'function') await ret;
                } catch (err) {
                    console.error(err);
                    fired = false;
                    b.disabled = false;
                    b.textContent = prevText;
                }
            };
        }
        footer.appendChild(b);
    });
    $('#modal').classList.remove('hidden');
}

function closeModal() {
    $('#modal').classList.add('hidden');
}

// ==================== TIMERS ====================
function updateTimers() {
    $$('.timer').forEach(el => {
        const start = el.dataset.start;
        if (start) el.textContent = timeUntil(start);
    });
}

// ==================== SPLASH & BOOT ====================
let _splashPercent = 0;
function updateSplash(percent, message) {
    const status = document.getElementById('splash-status');
    const bar = document.getElementById('splash-bar-fill');
    // Never go backwards — smooth fill only forward
    if (typeof percent === 'number' && percent > _splashPercent) {
        _splashPercent = percent;
    }
    if (status && message) status.textContent = message;
    if (bar) bar.style.width = _splashPercent + '%';
}

/** Smoothly creep progress while waiting (feels alive, not stuck) */
function splashCreep(target, ms) {
    return new Promise(resolve => {
        const start = _splashPercent;
        const dist = Math.max(0, target - start);
        if (dist <= 0) { resolve(); return; }
        const t0 = Date.now();
        const tick = () => {
            const p = Math.min(1, (Date.now() - t0) / ms);
            const eased = 1 - Math.pow(1 - p, 2);
            updateSplash(start + dist * eased);
            if (p < 1) requestAnimationFrame(tick);
            else resolve();
        };
        requestAnimationFrame(tick);
    });
}

function hideSplash() {
    const screen = document.getElementById('loading-screen');
    if (screen) {
        screen.classList.add('fade-out');
        screen.style.opacity = '0';
        setTimeout(() => {
            screen.style.display = 'none';
            screen.classList.add('hidden');
        }, 180);
    }
}

function initSplashParticles() {
    const particles = document.getElementById('splash-particles');
    if (particles && !particles.children.length) {
        for (let i = 0; i < 18; i++) {
            const s = document.createElement('span');
            s.style.left = Math.random() * 100 + '%';
            s.style.animationDelay = (Math.random() * 5) + 's';
            s.style.animationDuration = (4 + Math.random() * 4) + 's';
            s.style.width = s.style.height = (2 + Math.random() * 4) + 'px';
            particles.appendChild(s);
        }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    initSplashParticles();

    // Never stay on splash forever (APK/WebView + slow net safe)
    const minSplashTime = 120;
    const maxSplashTime = 3500; // hard limit 3.5s
    const startTime = Date.now();
    _splashPercent = 0;
    updateSplash(10, 'Initializing...');

    let bootDone = false;
    let bootError = null;

    const ticker = setInterval(() => {
        if (bootDone) return;
        const next = Math.min(92, _splashPercent + 4);
        let msg = 'Initializing...';
        if (next >= 20 && next < 45) msg = 'Connecting...';
        else if (next >= 45 && next < 70) msg = 'Loading data...';
        else if (next >= 70) msg = 'Almost ready...';
        updateSplash(next, msg);
    }, 25);

    const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), ms))
    ]);

    try {
        await withTimeout(initDB(), 4500, 'initDB');
        updateSplash(Math.max(_splashPercent, 88), 'Preparing login...');
        await withTimeout(checkSession(), 2000, 'checkSession');
        bootDone = true;
        clearInterval(ticker);
        updateSplash(100, 'Ready!');
        await new Promise(r => setTimeout(r, 20));
    } catch (e) {
        console.error('Init error:', e);
        bootError = e;
        bootDone = true;
        clearInterval(ticker);
        updateSplash(100, 'Ready!');
        // Offline / slow: still open app with cache / empty state
        try { await checkSession(); } catch (e2) { console.warn(e2); }
        await new Promise(r => setTimeout(r, 40));
    }
    clearInterval(ticker);
    bootDone = true;

    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, Math.min(minSplashTime - elapsed, maxSplashTime - elapsed));
    // Absolute safety: never exceed maxSplashTime on screen
    const hardLeft = Math.max(0, maxSplashTime - (Date.now() - startTime));
    await new Promise(r => setTimeout(r, Math.min(remaining, hardLeft)));
    hideSplash();
    // Force-hide again in case CSS fade failed (WebView)
    setTimeout(() => {
        const screen = document.getElementById('loading-screen');
        if (screen) {
            screen.style.display = 'none';
            screen.classList.add('hidden');
        }
        applyAppLockGate();
    }, 300);

    // Seed history so first phone-Back stays inside app
    try {
        history.replaceState({ app: true, page: 'play' }, '', '#play');
        history.pushState({ app: true, page: currentUser ? 'play' : 'play' }, '', '#play');
    } catch (e) {}
    appNavStack = ['play'];
    currentAppPage = 'play';

    setTimeout(() => {
        if (currentUser) {
            $('#auth-container')?.classList.add('hidden');
            $('#app-container')?.classList.remove('hidden');
        } else {
            $('#auth-container')?.classList.remove('hidden');
            $('#app-container')?.classList.add('hidden');
        }
        if (bootError) toast('নেট ধীর বা কানেক্ট সমস্যা — আবার চেষ্টা করুন');
    }, 50);

    // Auth forms
    $('#login-form')?.addEventListener('submit', e => {
        e.preventDefault();
        login($('#login-username').value.trim(), $('#login-password').value);
    });

    $('#register-form')?.addEventListener('submit', e => {
        e.preventDefault();
        const pass = $('#reg-password').value;
        const conf = $('#reg-confirm').value;
        if (pass !== conf) return toast('পাসওয়ার্ড মিলছে না!');
        register(
            $('#reg-username').value.trim(),
            $('#reg-phone').value.trim(),
            pass,
            $('#reg-email').value.trim()
        );
    });

    $('#show-register')?.addEventListener('click', e => {
        e.preventDefault();
        $('#login-screen').classList.add('hidden');
        $('#forgot-screen')?.classList.add('hidden');
        $('#register-screen').classList.remove('hidden');
    });

    $('#show-login')?.addEventListener('click', e => {
        e.preventDefault();
        $('#register-screen').classList.add('hidden');
        $('#forgot-screen')?.classList.add('hidden');
        $('#login-screen').classList.remove('hidden');
    });

    $('#show-forgot')?.addEventListener('click', e => {
        e.preventDefault();
        $('#login-screen').classList.add('hidden');
        $('#register-screen').classList.add('hidden');
        $('#forgot-screen').classList.remove('hidden');
        $('#forgot-step1').classList.remove('hidden');
        $('#forgot-step2').classList.add('hidden');
    });

    $('#show-login-from-forgot')?.addEventListener('click', e => {
        e.preventDefault();
        $('#forgot-screen').classList.add('hidden');
        $('#login-screen').classList.remove('hidden');
    });

    let tempOtp = null;
    let tempForgotUser = null;

    $('#btn-send-otp')?.addEventListener('click', async () => {
        const username = $('#forgot-username').value.trim();
        const email = $('#forgot-email').value.trim().toLowerCase();
        if (!username || !email) return toast('ইউজারনেম ও ইমেইল দিন');
        CACHE.users = await cloudGetAll('users');
        const user = CACHE.users.find(u => u.username.toLowerCase() === username.toLowerCase() && (u.email || '').toLowerCase() === email);
        if (!user) return toast('ইউজারনেম বা ইমেইল মিলছে না!');
        tempOtp = String(Math.floor(100000 + Math.random() * 900000));
        tempForgotUser = user;
        toast('কোড: ' + tempOtp + ' (ডেমো মোড)');
        $('#forgot-step1').classList.add('hidden');
        $('#forgot-step2').classList.remove('hidden');
    });

    $('#btn-reset-pass')?.addEventListener('click', async () => {
        const otp = $('#forgot-otp').value.trim();
        const newPass = $('#forgot-newpass').value;
        if (otp !== tempOtp) return toast('কোড ভুল!');
        if (!newPass || newPass.length < 4) return toast('পাসওয়ার্ড কমপক্ষে ৪ অক্ষর');
        await cloudSet('users', tempForgotUser.id, { password: newPass });
        const u = CACHE.users.find(x => String(x.id) === String(tempForgotUser.id));
        if (u) u.password = newPass;
        toast('পাসওয়ার্ড সফলভাবে রিসেট হয়েছে!');
        tempOtp = null;
        tempForgotUser = null;
        $('#forgot-screen').classList.add('hidden');
        $('#login-screen').classList.remove('hidden');
    });

    // Bottom nav
    $$('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            navigateTo(item.dataset.page, { loader: true });
        });
    });

    // Back buttons
    $('#back-to-play')?.addEventListener('click', () => {
        // Prefer in-app back stack
        if (appNavStack.length > 1) {
            handleAppBack();
            return;
        }
        if (currentCategory && isProLeagueCategory(currentCategory)) navigateTo('pro-league');
        else navigateTo('play');
    });
    $('#back-to-profile')?.addEventListener('click', () => navigateTo('profile'));
    $('#back-to-wallet-from-deposit')?.addEventListener('click', () => navigateTo('wallet'));
    $('#back-to-profile-from-withdraw')?.addEventListener('click', () => navigateTo('profile'));
    $('#back-from-rules')?.addEventListener('click', () => navigateTo('profile'));
    $('#back-from-admin')?.addEventListener('click', () => navigateTo('profile'));
    $('#back-from-edit-profile')?.addEventListener('click', () => navigateTo('profile'));
    $('#back-from-topplayers')?.addEventListener('click', () => navigateTo('profile'));

    // Profile menus
    $('#menu-wallet')?.addEventListener('click', () => navigateTo('wallet'));
    $('#menu-withdraw')?.addEventListener('click', async () => {
        const fresh = await cloudGetDoc('users', currentUser.id);
        if (fresh) currentUser = fresh;
        $('#withdraw-balance').textContent = formatMoney(getWinningBalance(currentUser));
        clearWithdrawForm();
        navigateTo('withdraw');
    });
    $('#menu-tx-history')?.addEventListener('click', () => {
        currentTxHistoryTab = 'deposit';
        navigateTo('tx-history');
    });
    document.getElementById('btn-wallet-tx-history')?.addEventListener('click', () => {
        currentTxHistoryTab = 'deposit';
        navigateTo('tx-history');
    });
    $('#back-from-tx-history')?.addEventListener('click', () => navigateTo('profile'));
    document.getElementById('tx-history-tabs')?.addEventListener('click', (e) => {
        const tab = e.target.closest('.tx-tab');
        if (!tab) return;
        loadTxHistory(tab.dataset.txTab);
    });
    $('#menu-myprofile')?.addEventListener('click', () => openEditProfile());
    $('#menu-rules')?.addEventListener('click', () => navigateTo('rules'));
    $('#menu-topplayers')?.addEventListener('click', () => navigateTo('top-players'));
    $('#menu-admin')?.addEventListener('click', () => navigateTo('admin'));
    $('#logout-btn')?.addEventListener('click', logout);

    document.addEventListener('click', e => {
        if (e.target.closest('#copy-ref-btn')) {
            const code = $('#profile-ref-code')?.textContent || '';
            if (code && code !== '—') {
                navigator.clipboard?.writeText(code).then(() => toast('রেফারেল কোড কপি হয়েছে!')).catch(() => toast(code));
            }
        }
    });

    // Edit Profile
    $('#save-profile-btn')?.addEventListener('click', saveProfile);
    $('#change-my-password-btn')?.addEventListener('click', changeMyPassword);
    // Profile photo upload disabled

    // Wallet
    $('#btn-deposit')?.addEventListener('click', () => navigateTo('deposit', { loader: true }));
    document.addEventListener('click', e => {
        const tab = e.target.closest('.dep-tab');
        if (tab) {
            document.querySelectorAll('.dep-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderDepositInstructions(tab.dataset.method);
        }
    });
    $('#btn-go-withdraw')?.addEventListener('click', async () => {
        const w = getWinningBalance(currentUser);
        $('#withdraw-balance').textContent = formatMoney(w);
        const note = document.getElementById('withdraw-win-note');
        if (note) note.textContent = 'শুধু উইনিং প্রাইজ উইথড্র করা যাবে (ডিপোজিট উইথড্র নয়)';
        clearWithdrawForm();
        navigateTo('withdraw');
    });
    $('#submit-deposit')?.addEventListener('click', submitDeposit);
    $('#submit-withdraw')?.addEventListener('click', submitWithdraw);

    // Admin tabs
    $$('.admin-tab').forEach(tab => {
        tab.addEventListener('click', () => loadAdmin(tab.dataset.admin));
    });

    // Modal close
    $('#modal-close')?.addEventListener('click', closeModal);
    $('#modal')?.addEventListener('click', e => {
        if (e.target === $('#modal')) closeModal();
    });

    // Support
    $('#support-btn')?.addEventListener('click', () => {
        openExternalLink(getSupportTelegramUrl());
    });

    // Refresh matches
    $('#refresh-matches')?.addEventListener('click', async () => {
        if (firebaseReady) {
            CACHE.matches = await cloudGetAll('matches');
            CACHE.joins = await cloudGetAll('joins');
        }
        if (currentCategory) renderMatches(currentCategory);
        toast('Refreshed');
    });

    // Timers
    setInterval(updateTimers, 1000);
    if (typeof loadHomeSlider === 'function') loadHomeSlider();
});

// Global exports for onclick
window.openExternalLink = openExternalLink;
window.adminClearAllThumbs = adminClearAllThumbs;
window.loadHomeSlider = loadHomeSlider;
window.renderHomeSlider = renderHomeSlider;
window.showSuccessPopup = showSuccessPopup;
window.goToSlide = goToSlide;
window.adminChangeOwnPassword = adminChangeOwnPassword;
window.adminChangeUserPassword = adminChangeUserPassword;
window.changeMyPassword = changeMyPassword;
window.adminSearchUsers = adminSearchUsers;
window.adminToggleVerify = adminToggleVerify;
window.adminPayResultParticipant = adminPayResultParticipant;
window.adminPanelNotify = adminPanelNotify;
window.adminRemoveSliderSlide = adminRemoveSliderSlide;
window.adminAddSliderSlide = adminAddSliderSlide;
window.adminUpdateSliderLink = adminUpdateSliderLink;
window.fileToThumbDataUrl = fileToThumbDataUrl;
window.adminUploadModeThumb = adminUploadModeThumb;
window.isUsableThumbUrl = isUsableThumbUrl;
window.joinMatch = joinMatch;
window.openMatchDetails = openMatchDetails;
window.closeMatchDetails = closeMatchDetails;
window.adminToggleRegistration = adminToggleRegistration;
window.adminSetPointTableUrl = adminSetPointTableUrl;
window.watchCurrentUser = watchCurrentUser;
window.loadAllUsersForAdmin = loadAllUsersForAdmin;
window.adminAddSliderSlideFromUrl = adminAddSliderSlideFromUrl;
window.copyRoomField = copyRoomField;
window.showRoomDetails = showRoomDetails;
window.showMatchMaps = showMatchMaps;
window.showPrizeDetails = showPrizeDetails;
window.adminUploadPointTable = adminUploadPointTable;
window.showPublicMatchResult = showPublicMatchResult;
window.showPointTable = showPointTable;
window.navigateTo = navigateTo;
window.showJoinReceiptFromMyMatches = function (matchId, joinId) {
    const match = (CACHE.matches || []).find(m => String(m.id) === String(matchId));
    const joinRecord = (CACHE.joins || []).find(j => String(j.id) === String(joinId));
    if (match && joinRecord) showJoinReceipt(match, joinRecord);
};
window.adminCreateMatch = adminCreateMatch;
window.adminEditMatch = adminEditMatch;
window.adminEditRoom = adminEditRoom;
window.adminViewPlayers = adminViewPlayers;
window.adminEditMatchGroups = adminEditMatchGroups;
window.adminEditVersusMatch = adminEditVersusMatch;
window.adminMoveJoinGroup = adminMoveJoinGroup;
window.adminTransferJoinMatch = adminTransferJoinMatch;
window.adminCompleteMatch = adminCompleteMatch;
window.showPollPopup = showPollPopup;
window.castPollVote = castPollVote;
window.adminSavePoll = adminSavePoll;
window.adminClosePoll = adminClosePoll;
window.adminDeleteMatch = adminDeleteMatch;
window.adminRestoreDeletedMatch = adminRestoreDeletedMatch;
window.adminPermanentDeleteMatch = adminPermanentDeleteMatch;
window.adminRefundMatch = adminRefundMatch;
window.adminOpenResults = adminOpenResults;
window.adminEditJoinName = adminEditJoinName;
window.adminRefundJoin = adminRefundJoin;
window.adminRemoveJoinOnly = adminRemoveJoinOnly;
window.adminRestoreMatchFromResults = adminRestoreMatchFromResults;
window.adminCopyMatch = adminCopyMatch;
window.adminDeletePointTable = adminDeletePointTable;
window.syncPublicLeaderboard = syncPublicLeaderboard;
window.adminRebuildLeaderboard = adminRebuildLeaderboard;
window.adminApproveDeposit = adminApproveDeposit;
window.adminRejectDeposit = adminRejectDeposit;
window.adminApproveWithdraw = adminApproveWithdraw;
window.adminRejectWithdraw = adminRejectWithdraw;
window.adminAddBalance = adminAddBalance;
window.adminDeductBalance = adminDeductBalance;
window.adminSaveModeRules = adminSaveModeRules;
window.adminSaveModeThumb = adminSaveModeThumb;
window.adminSaveModeEdit = adminSaveModeEdit;
window.adminAddMode = adminAddMode;
window.adminDeleteMode = adminDeleteMode;
window.adminSaveSettings = adminSaveSettings;
window.adminCleanupOrphanJoins = adminCleanupOrphanJoins;
window.applyAppLockGate = applyAppLockGate;
window.adminSaveProLeagueMode = adminSaveProLeagueMode;
window.renderAdminProLeagueControl = renderAdminProLeagueControl;
window.adminToggleBan = adminToggleBan;
window.showEntryPopup = showEntryPopup;
window.openCategory = openCategory;
window.ensureProLeagueCategory = ensureProLeagueCategory;
window.openProLeagueHome = openProLeagueHome;
window.isProLeagueCategory = isProLeagueCategory;
window.closeModal = closeModal;

window.showStoredMatchResult = showStoredMatchResult;

window.adminEditResultDist = adminEditResultDist;

window.adminToggleResultPublic = adminToggleResultPublic;

window.adminDeleteMatchResult = adminDeleteMatchResult;

window.renderAdminResultDist = renderAdminResultDist;

window.adminOpenPlayerPrizeFromResult = adminOpenPlayerPrizeFromResult;
