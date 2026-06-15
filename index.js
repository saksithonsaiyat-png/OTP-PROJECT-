const express = require('express');
const cors = require('cors'); // นำเข้าไลบรารี CORS เพื่อแก้ปัญหาบล็อกโดเมน
const path = require('path');
const fs = require('fs');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();
const port = 3000;

// ========================================================
// ⚙️ ตั้งค่าบัญชีอีเมลหลักของร้าน (Maily.space)
// ========================================================
const emailConfig = {
    imap: {
        // ⚠️ แก้ไข Username และ Password ของคุณที่นี่
        user: 'aisstream', // หรืออาจจะต้องใส่เป็น aisstream@maily.space ลองดูครับ
        password: 'YOUR_PASSWORD', // <--- ลบคำนี้ออก แล้วใส่รหัสผ่าน Natthanan@ ของคุณลงไปแทน
        host: 'mail.maily.space',
        port: 993,
        tls: true,
        authTimeout: 15000,
        tlsOptions: { rejectUnauthorized: false }
    }
};

const SENDER_EMAILS = {
    'disney': 'disneyplus@mail.disneyplus.com',
    'chatgpt': 'noreply@openai.com',
    'trueid': 'no-reply@trueid.net',
    'youku': 'no-reply@youku.com'
};

async function getRealOTP(service, targetEmail) {
    const senderEmail = SENDER_EMAILS[service];
    if (!senderEmail) {
        throw new Error('ไม่รองรับบริการนี้');
    }

    if (emailConfig.imap.password === 'YOUR_PASSWORD') {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠️ IMAP Password is not configured. Falling back to Mock OTP.`);
        return null;
    }

    try {
        console.log(`[${new Date().toLocaleTimeString()}] ⏳ Connecting IMAP to find OTP of ${service} for ${targetEmail}...`);
        const connection = await imaps.connect(emailConfig);
        await connection.openBox('INBOX');

        const searchCriteria = [
            'UNSEEN',
            ['FROM', senderEmail],
            ['TO', targetEmail]
        ];

        const fetchOptions = { bodies: ['HEADER', 'TEXT', ''], markSeen: true };
        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            connection.end();
            console.log(`❌ No new OTP email found for ${targetEmail}`);
            throw new Error('ยังไม่มีข้อความ OTP เข้ามา กรุณารอสักครู่แล้วลองใหม่');
        }

        const latestMessage = messages[messages.length - 1];
        const allParts = latestMessage.parts.find(p => p.which === '');
        const parsedMail = await simpleParser(allParts.body);
        const emailBody = parsedMail.text || parsedMail.html || '';

        connection.end();

        const otpRegex = /\b\d{4,6}\b/;
        const match = emailBody.match(otpRegex);

        if (match) {
            console.log(`✅ Found OTP: ${match[0]}`);
            return match[0];
        } else {
            console.log(`❌ Found email but failed to extract OTP`);
            throw new Error('พบอีเมลแต่ไม่สามารถดึงรหัสตัวเลขได้');
        }
    } catch (error) {
        console.error('🔥 IMAP Error:', error.message);
        throw new Error(error.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์อีเมลได้ โปรดตรวจสอบการตั้งค่า');
    }
}

// เปิดใช้งาน CORS ให้ทุกโดเมนสามารถยิง API มาหาหลังบ้านได้
app.use(cors({ origin: '*' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ==========================================
// ระบบจัดการฐานข้อมูล (db.json)
// ==========================================
const DB_FILE = path.join(__dirname, 'db.json');

const defaultDB = {
    admin: { username: "admin", password: "password" },
    globalSettings: { disney: true, chatgpt: true, trueid: true, youku: true },
    emails: [],
    history: [],
    inbox: []
};

function initDB() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2), 'utf8');
}
initDB();

function getDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return defaultDB; }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function logToInbox(email, service, code, system) {
    const db = getDB();
    const now = Date.now();
    const msg = {
        id: now.toString(),
        timestamp: now,
        time: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
        from: `no-reply@${service}.com`,
        to: email,
        subject: `รหัสยืนยัน OTP ของคุณสำหรับ ${service.toUpperCase()}`,
        message: `คุณได้ทำการขอรหัสยืนยัน OTP สำหรับแอปพลิเคชัน ${service}\nรหัส OTP ของคุณคือ: ${code}`,
        system: system
    };
    db.inbox.unshift(msg);
    saveDB(db);
}

// ==========================================
// การทำ Routing หน้าเว็บหลัก
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// API หน้าบ้าน (ระบบขอ OTP ของลูกค้า)
// ==========================================
app.get('/api/get-otp', async (req, res) => {
    const { email, service, device, systemType, pin } = req.query;
    const db = getDB();

    // เช็คการปิดระบบรายแอป (Global Setting)
    if (!db.globalSettings[service]) {
        return res.status(400).json({ success: false, error: "ระบบปิดให้บริการแอปพลิเคชันนี้ชั่วคราว" });
    }

    // ค้นหาอีเมลในระบบ
    let userEmail = db.emails.find(e => e.email === email && e.system === systemType);
    if (!userEmail) {
        // ถ้ายังไม่มีอีเมลในระบบ ให้เพิ่มอัตโนมัติ
        userEmail = {
            id: Date.now().toString(), email: email, system: systemType, isActive: true, pin: "",
            services: { disney: true, chatgpt: true, trueid: true, youku: true }
        };
        db.emails.push(userEmail);
        saveDB(db);
    }

    // เช็คสถานะการให้บริการของอีเมลนี้
    if (!userEmail.isActive) return res.status(400).json({ success: false, error: "อีเมลนี้ถูกระงับการให้บริการชั่วคราว" });
    if (!userEmail.services[service]) return res.status(400).json({ success: false, error: `อีเมลนี้ไม่ได้เปิดใช้งานแอปพลิเคชัน ${service}` });

    // เช็ครหัส PIN (ถ้ามีการตั้งไว้)
    if (userEmail.pin && userEmail.pin !== "") {
        if (!pin) return res.json({ success: false, requirePin: true });
        if (pin !== userEmail.pin) return res.status(400).json({ success: false, error: "รหัส PIN ความปลอดภัยไม่ถูกต้อง" });
    }

    let otpCode;
    try {
        const realOtp = await getRealOTP(service, email);
        if (realOtp) {
            otpCode = realOtp;
        } else {
            // Fallback to mock/random OTP
            otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        }
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }

    const timeNow = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const dateNow = new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });

    // บันทึกประวัติและกล่องข้อความ
    db.history.unshift({ time: timeNow, dateStr: dateNow, email, device: device || 'ไม่ระบุ', service, system: systemType, otp: otpCode });
    saveDB(db);
    logToInbox(email, service, otpCode, systemType);

    // ดึง OTP ย้อนหลัง 10 นาที (ยกเว้นอันที่เพิ่งสร้าง)
    const tenMinMs = 10 * 60 * 1000;
    const nowMs = Date.now();
    const freshDB = getDB();
    const recentOtps = freshDB.inbox
        .filter(m => {
            if (m.to !== email) return false;
            if (!m.subject.toLowerCase().includes(service)) return false;
            const ts = m.timestamp ? m.timestamp : (nowMs - tenMinMs - 1); // old entries without timestamp are excluded
            const age = nowMs - ts;
            return age > 1000 && age <= tenMinMs; // exclude the one just created (age > 1s)
        })
        .slice(0, 9)
        .map(m => {
            const codeMatch = m.message.match(/\b\d{4,6}\b/);
            const ts = m.timestamp || null;
            const minutesAgo = ts ? Math.round((nowMs - ts) / 60000) : null;
            return codeMatch ? { code: codeMatch[0], time: m.time, timestamp: ts, minutesAgo } : null;
        })
        .filter(Boolean);

    res.json({ success: true, code: otpCode, recentOtps });
});

app.get('/api/settings', (req, res) => {
    const db = getDB();
    res.json({ success: true, settings: db.globalSettings });
});

app.post('/api/admin/upload-banner', (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false, error: 'ไม่มีข้อมูลรูปภาพ' });
    try {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(path.join(__dirname, 'banner.png'), base64Data, 'base64');
        const db = getDB();
        db.globalSettings.bannerUrl = './banner.png';
        saveDB(db);
        res.json({ success: true, bannerUrl: './banner.png' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// API แอดมินจัดการหลังบ้าน
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const db = getDB();
    if (username === db.admin.username && password === db.admin.password) res.json({ success: true });
    else res.json({ success: false });
});

app.get('/api/admin/data', (req, res) => { res.json(getDB()); });

app.post('/api/admin/save-settings', (req, res) => {
    const db = getDB(); db.globalSettings = req.body.settings;
    saveDB(db); res.json({ success: true });
});

app.post('/api/admin/update-admin', (req, res) => {
    const db = getDB(); db.admin.username = req.body.username; db.admin.password = req.body.password;
    saveDB(db); res.json({ success: true });
});

app.post('/api/admin/update-email', (req, res) => {
    const db = getDB(); const idx = db.emails.findIndex(e => e.id === req.body.id);
    if (idx !== -1) { db.emails[idx] = req.body; saveDB(db); }
    res.json({ success: true });
});

app.post('/api/admin/add-email', (req, res) => {
    const db = getDB();
    const { email, system } = req.body;
    if (!db.emails.find(e => e.email === email && e.system === system)) {
        db.emails.push({
            id: Date.now().toString(), email: email, system: system, isActive: true, pin: "",
            services: { disney: true, chatgpt: true, trueid: true, youku: true }
        });
        saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/admin/delete-email', (req, res) => {
    const db = getDB();
    db.emails = db.emails.filter(e => e.id !== req.body.id);
    saveDB(db); res.json({ success: true });
});

app.post('/api/admin/delete-inbox', (req, res) => {
    const db = getDB(); db.inbox = db.inbox.filter(m => m.id !== req.body.id);
    saveDB(db); res.json({ success: true });
});

app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ระบบจัดการหลังบ้าน (Admin Dashboard)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
    <link href="https://cdn.jsdelivr.net/gh/lazywasabi/thai-web-fonts@latest/fonts/LINESeedSansTH/LINESeedSansTH.css" rel="stylesheet" />
    <style>
        body { font-family: 'LINE Seed Sans TH', sans-serif; background-color: #f3f4f6; }
        .tab-btn.active { background-color: #e5e7eb; color: #111827; font-weight: 700; border-left: 4px solid #3b82f6; }
    </style>
</head>
<body x-data="adminApp()">

    <!-- หน้า Login -->
    <div x-show="!isLoggedIn" class="min-h-screen flex items-center justify-center bg-gray-900 p-4">
        <div class="bg-white p-6 md:p-10 rounded-2xl shadow-2xl w-full max-w-sm text-center">
            <div class="bg-blue-100 text-blue-600 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"><svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg></div>
            <h2 class="text-xl md:text-2xl font-bold mb-6 text-gray-800">ระบบจัดการหลังบ้าน</h2>
            <input type="text" x-model="loginUser" placeholder="Username" class="w-full p-4 border border-gray-200 rounded-xl mb-4 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all text-left">
            <input type="password" x-model="loginPass" placeholder="Password" class="w-full p-4 border border-gray-200 rounded-xl mb-6 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all text-left" @keyup.enter="login()">
            <button @click="login()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-lg hover:bg-blue-700 active:scale-95 transition-all text-lg">เข้าสู่ระบบ</button>
            <p x-show="loginError" class="text-red-500 text-sm mt-4 font-bold bg-red-50 py-2 rounded-lg">ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!</p>
            <a href="/" class="block mt-6 text-sm text-gray-500 hover:text-blue-500 hover:underline font-medium">มุมมองผู้ใช้งาน</a>
        </div>
    </div>

    <!-- หน้า Dashboard -->
    <div x-show="isLoggedIn" style="display:none;" class="flex flex-col md:flex-row h-screen overflow-hidden">
        
        <!-- Mobile Header Bar -->
        <div class="md:hidden flex items-center justify-between p-4 bg-white border-b border-gray-200 z-30 shadow-sm w-full">
            <button @click="mobileMenuOpen = !mobileMenuOpen" class="p-2 rounded-xl bg-gray-50 text-gray-700 hover:bg-gray-100 focus:outline-none">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 6h16M4 12h16M4 18h16"></path>
                </svg>
            </button>
            <div class="text-xl font-black text-gray-900 flex items-center space-x-2">
                <span>Admin Panel</span>
            </div>
            <div class="w-10"></div>
        </div>

        <!-- Mobile Sidebar Backdrop Overlay -->
        <div x-show="mobileMenuOpen" @click="mobileMenuOpen = false" class="fixed inset-0 bg-black/55 z-40 md:hidden" style="display: none;" x-transition></div>
        
        <!-- Sidebar Navigation -->
        <div :class="mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
             class="fixed md:static inset-y-0 left-0 w-64 bg-white text-gray-700 flex flex-col shadow-lg border-r border-gray-200 z-50 md:z-20 transform transition-transform duration-300 ease-in-out h-full">
            <div class="p-6 text-xl font-black text-center border-b border-gray-100 text-gray-900 flex items-center justify-center space-x-2">
                <span><svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></span><span>Admin Panel</span>
            </div>
            <nav class="flex-1 py-4 flex flex-col space-y-1 bg-white overflow-y-auto">
                <button @click="tab = 'dashboard'; mobileMenuOpen = false" :class="tab=='dashboard'?'bg-gray-100 text-gray-900 border-l-4 border-blue-600 font-bold':'border-l-4 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'" class="w-full text-left px-6 py-4 font-medium transition-all flex items-center space-x-3"><svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg><span>ภาพรวม / Dashboard</span></button>
                <button @click="tab = 'emails'; mobileMenuOpen = false" :class="tab=='emails'?'bg-gray-100 text-gray-900 border-l-4 border-blue-600 font-bold':'border-l-4 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'" class="w-full text-left px-6 py-4 font-medium transition-all flex items-center space-x-3"><svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg><span>จัดการอีเมลทั้งหมด</span></button>
                <button @click="tab = 'inbox'; mobileMenuOpen = false" :class="tab=='inbox'?'bg-gray-100 text-gray-900 border-l-4 border-blue-600 font-bold':'border-l-4 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'" class="w-full text-left px-6 py-4 font-medium transition-all flex items-center space-x-3"><svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-17.5 0V6.75A2.25 2.25 0 016.375 4.5h11.25a2.25 2.25 0 012.25 2.25v6.75m-17.625 0h-.375a2.25 2.25 0 00-2.25 2.25v1.5a2.25 2.25 0 002.25 2.25h19.5a2.25 2.25 0 002.25-2.25v-1.5a2.25 2.25 0 00-2.25-2.25h-.375" /></svg><span>กล่องจดหมายรวม</span></button>
                <button @click="tab = 'history'; mobileMenuOpen = false" :class="tab=='history'?'bg-gray-100 text-gray-900 border-l-4 border-blue-600 font-bold':'border-l-4 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'" class="w-full text-left px-6 py-4 font-medium transition-all flex items-center space-x-3"><svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg><span>ประวัติการทำรายการ</span></button>
                <button @click="tab = 'settings'; mobileMenuOpen = false" :class="tab=='settings'?'bg-gray-100 text-gray-900 border-l-4 border-blue-600 font-bold':'border-l-4 border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'" class="w-full text-left px-6 py-4 font-medium transition-all flex items-center space-x-3"><svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg><span>ตั้งค่าระบบหลังบ้าน</span></button>
            </nav>
            <div class="p-4 border-t border-gray-100 space-y-3 bg-white">
                <a href="/" class="block w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-bold transition-colors text-center text-sm shadow-sm">มุมมองผู้ใช้งาน</a>
                <button @click="logout(); mobileMenuOpen = false" class="block w-full bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 transition-colors shadow-sm">ออกจากระบบ</button>
            </div>
        </div>
        
        <!-- Main Content Area -->
        <div class="flex-1 overflow-y-auto bg-gray-50 relative">
            
            <!-- Tab: Dashboard -->
            <div x-show="tab === 'dashboard'" class="p-4 md:p-8 max-w-6xl mx-auto">
                <h1 class="text-2xl md:text-3xl font-bold mb-6 md:mb-8 text-gray-800 border-b pb-4 flex items-center space-x-3"><svg class="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg><span>ภาพรวมสถิติการใช้บริการ / Dashboard</span></h1>
                
                <h2 class="text-base md:text-lg font-bold mb-4 text-gray-600">จำนวนอีเมลที่พร้อมให้บริการ</h2>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6 mb-10">
                    <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                        <div>
                            <div class="text-gray-500 font-bold mb-1 text-sm md:text-base">อีเมลจาก Gmail เชื่อมต่อโดยตรง</div>
                            <div class="text-3xl md:text-4xl font-black text-gray-800" x-text="db.emails.filter(e=>e.system==='Gmail').length"></div>
                        </div>
                        <div class="w-12 h-12 md:w-16 md:h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center text-2xl md:text-3xl">G</div>
                    </div>
                    <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                        <div>
                            <div class="text-gray-500 font-bold mb-1 text-sm md:text-base">อีเมลโดเมนจาก Maily Space</div>
                            <div class="text-3xl md:text-4xl font-black text-gray-800" x-text="db.emails.filter(e=>e.system==='MailySpace').length"></div>
                        </div>
                        <div class="w-12 h-12 md:w-16 md:h-16 bg-blue-50 text-blue-500 rounded-full flex items-center justify-center text-2xl md:text-3xl">M</div>
                    </div>
                </div>

                <h2 class="text-base md:text-lg font-bold mb-4 text-gray-600">สถิติการค้นหา OTP (วันนี้)</h2>
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-8">
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Disney+</div>
                        <div class="text-3xl md:text-4xl font-black text-blue-600 mt-2" x-text="countAppDaily('disney')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">ChatGPT</div>
                        <div class="text-3xl md:text-4xl font-black text-emerald-600 mt-2" x-text="countAppDaily('chatgpt')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">TrueID</div>
                        <div class="text-3xl md:text-4xl font-black text-red-600 mt-2" x-text="countAppDaily('trueid')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Youku</div>
                        <div class="text-3xl md:text-4xl font-black text-sky-500 mt-2" x-text="countAppDaily('youku')"></div>
                    </div>
                </div>

                <h2 class="text-base md:text-lg font-bold mb-4 text-gray-600">สถิติการค้นหา OTP (สัปดาห์นี้)</h2>
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-8">
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Disney+</div>
                        <div class="text-3xl md:text-4xl font-black text-blue-600 mt-2" x-text="countAppWeekly('disney')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">ChatGPT</div>
                        <div class="text-3xl md:text-4xl font-black text-emerald-600 mt-2" x-text="countAppWeekly('chatgpt')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">TrueID</div>
                        <div class="text-3xl md:text-4xl font-black text-red-600 mt-2" x-text="countAppWeekly('trueid')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Youku</div>
                        <div class="text-3xl md:text-4xl font-black text-sky-500 mt-2" x-text="countAppWeekly('youku')"></div>
                    </div>
                </div>

                <h2 class="text-base md:text-lg font-bold mb-4 text-gray-600">สถิติการค้นหา OTP (เดือนนี้)</h2>
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Disney+</div>
                        <div class="text-3xl md:text-4xl font-black text-blue-600 mt-2" x-text="countAppMonthly('disney')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">ChatGPT</div>
                        <div class="text-3xl md:text-4xl font-black text-emerald-600 mt-2" x-text="countAppMonthly('chatgpt')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">TrueID</div>
                        <div class="text-3xl md:text-4xl font-black text-red-600 mt-2" x-text="countAppMonthly('trueid')"></div>
                    </div>
                    <div class="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-gray-100 text-center">
                        <div class="text-gray-400 font-bold text-xs md:text-sm">Youku</div>
                        <div class="text-3xl md:text-4xl font-black text-sky-500 mt-2" x-text="countAppMonthly('youku')"></div>
                    </div>
                </div>
            </div>

            <!-- Tab: Manage Emails -->
            <div x-show="tab === 'emails'" class="p-4 md:p-8 max-w-7xl mx-auto">
                <h1 class="text-2xl md:text-3xl font-bold mb-6 md:mb-8 text-gray-800 border-b pb-4 flex items-center space-x-3"><svg class="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg><span>จัดการอีเมล Gmail / Domain</span></h1>
                
                <!-- แท็บแยกระบบอีเมล -->
                <div class="flex space-x-2 mb-6 bg-white p-2 rounded-xl shadow-sm border border-gray-200 inline-flex w-auto max-w-full overflow-x-auto no-scrollbar">
                    <button @click="emailTab = 'Gmail'; emailPage = 1" :class="emailTab=='Gmail'?'bg-red-500 text-white shadow-md':'bg-transparent text-gray-600 hover:bg-gray-100'" class="px-5 md:px-8 py-2.5 md:py-3 rounded-lg font-bold transition-all text-sm md:text-base whitespace-nowrap">อีเมลจาก Gmail</button>
                    <button @click="emailTab = 'MailySpace'; emailPage = 1" :class="emailTab=='MailySpace'?'bg-blue-600 text-white shadow-md':'bg-transparent text-gray-600 hover:bg-gray-100'" class="px-5 md:px-8 py-2.5 md:py-3 rounded-lg font-bold transition-all text-sm md:text-base whitespace-nowrap">อีเมลโดเมนจาก Maily Space</button>
                </div>
 
                <!-- กล่องเพิ่มอีเมล และ ช่องค้นหา -->
                <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
                    <div class="col-span-1 md:col-span-3 flex flex-col sm:flex-row gap-3 bg-white p-4 rounded-xl shadow-sm border border-gray-200 sm:items-end">
                        <div class="flex-1">
                            <label class="text-sm font-bold text-gray-600 block mb-1">เพิ่มอีเมล <span x-text="emailTab === 'Gmail' ? 'Gmail ใหม่' : 'Domain ใหม่'"></span></label>
                            <input type="email" x-model="newEmail" placeholder="กรอกอีเมลที่ต้องการเพิ่ม" class="w-full p-3 border border-gray-300 rounded-xl outline-none focus:border-blue-500 transition-all font-medium text-gray-800">
                        </div>
                        <button @click="addEmail()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3.5 rounded-xl font-bold shadow-sm transition-all flex items-center justify-center space-x-2 shrink-0"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg><span>เพิ่มข้อมูล</span></button>
                    </div>
                    <div class="col-span-1 md:col-span-2 flex flex-col justify-end bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                        <label class="text-sm font-bold text-gray-600 block mb-1">ค้นหาเมล</label>
                        <input type="text" x-model="searchEmail" @input="emailPage = 1" placeholder="กรอกอีเมลที่ต้องการค้นหา" class="w-full p-3 rounded-xl border border-gray-300 outline-none focus:border-blue-500 transition-all font-medium">
                    </div>
                </div>
 
                <!-- คู่มือตั้งค่า Gmail (Gmail Tab Only) -->
                <div x-show="emailTab === 'Gmail'" class="mb-6" x-transition>
                    <div class="rounded-2xl border border-blue-200 overflow-hidden shadow-sm">
                        <!-- Header Toggle -->
                        <button @click="showGmailGuide = !showGmailGuide" class="w-full flex items-center justify-between p-4 md:p-5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 transition-all">
                            <div class="flex items-center space-x-3">
                                <div class="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V19.5A2.25 2.25 0 0010.5 21h6a2.25 2.25 0 002.25-2.25v-.75M12 12.75h.008v.008H12v-.008z" /></svg>
                                </div>
                                <div class="text-left">
                                    <div class="font-bold text-base">วิธีตั้งค่า Gmail App Password สำหรับลูกค้า</div>
                                    <div class="text-blue-100 text-xs mt-0.5">คลิกเพื่อดูคู่มือทีละขั้นตอน</div>
                                </div>
                            </div>
                            <svg class="w-5 h-5 transition-transform duration-300" :class="showGmailGuide ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
                        </button>

                        <!-- Guide Content -->
                        <div x-show="showGmailGuide" x-transition:enter="transition ease-out duration-300" x-transition:enter-start="opacity-0 -translate-y-2" x-transition:enter-end="opacity-100 translate-y-0" class="bg-white p-5 md:p-6">

                            <!-- Intro note -->
                            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3.5 mb-5 flex items-start space-x-3">
                                <svg class="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                                <div>
                                    <div class="font-bold text-amber-800 text-sm">สิ่งที่ต้องทำ ก่อนเพิ่มอีเมล Gmail เข้าระบบ</div>
                                    <div class="text-amber-700 text-xs mt-1">ลูกค้าต้องสร้าง <strong>App Password</strong> จาก Google Account ก่อน เพื่อให้ระบบสามารถเชื่อมต่อกล่องจดหมายได้อัตโนมัติ</div>
                                </div>
                            </div>

                            <!-- Steps -->
                            <div class="space-y-5">

                                <!-- Step 1 -->
                                <div class="flex gap-4 items-start">
                                    <div class="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-sm">1</div>
                                    <div class="flex-1">
                                        <div class="font-bold text-gray-800 mb-1">เข้าไปที่ Google Account ของคุณ</div>
                                        <div class="text-sm text-gray-500 mb-2">เปิดบราวเซอร์แล้วไปที่ <a href="https://myaccount.google.com" target="_blank" class="text-blue-600 font-bold hover:underline">myaccount.google.com</a> เข้าสู่บัญชี Google ของคุณให้เรียบร้อย</div>
                                    </div>
                                </div>

                                <!-- Step 2 -->
                                <div class="flex gap-4 items-start">
                                    <div class="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-sm">2</div>
                                    <div class="flex-1">
                                        <div class="font-bold text-gray-800 mb-1">เปิด “การยืนยันตัวตนแบบ 2 ขั้นตอน” (2-Step Verification)</div>
                                        <div class="text-sm text-gray-500 mb-2">ไปที่เมนู <strong>ความปลอดภัย (Security)</strong> แล้วเปิดใช้งาน <strong>การยืนยันตัวตนแบบ 2 ขั้นตอน</strong> ถ้ายังไม่ได้เปิด</div>
                                        <img src="/gmail_guide_step1.png" class="w-full max-w-sm rounded-xl border border-gray-200 shadow-sm mt-2" alt="Google Security Settings" onerror="this.style.display='none'">
                                    </div>
                                </div>

                                <!-- Step 3 -->
                                <div class="flex gap-4 items-start">
                                    <div class="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-sm">3</div>
                                    <div class="flex-1">
                                        <div class="font-bold text-gray-800 mb-1">ค้นหา “รหัสผ่านสำหรับแอป” (App passwords)</div>
                                        <div class="text-sm text-gray-500 mb-2">หลังจากเปิด 2-Step Verification แล้ว ให้เลื่อนลงมาด้านล่างแล้วคลิกที่ <strong class="text-blue-700">รหัสผ่านสำหรับแอป</strong> หรือไปที่ <a href="https://myaccount.google.com/apppasswords" target="_blank" class="text-blue-600 font-bold hover:underline">myaccount.google.com/apppasswords</a></div>
                                    </div>
                                </div>

                                <!-- Step 4 -->
                                <div class="flex gap-4 items-start">
                                    <div class="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-sm">4</div>
                                    <div class="flex-1">
                                        <div class="font-bold text-gray-800 mb-1">สร้าง App Password ใหม่</div>
                                        <div class="text-sm text-gray-500 mb-2">ใส่ชื่อแอปเป็น <strong>OTP System</strong> แล้วกดปุ่ม <strong>สร้าง</strong> ระบบจะสร้างรหัสผ่าน 16 หลัก ให้คัดลอกไว้ทันที</div>
                                        <img src="/gmail_guide_step2.png" class="w-full max-w-sm rounded-xl border border-gray-200 shadow-sm mt-2" alt="App Password Creation" onerror="this.style.display='none'">
                                    </div>
                                </div>

                                <!-- Step 5 -->
                                <div class="flex gap-4 items-start">
                                    <div class="flex-shrink-0 w-8 h-8 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-sm">5</div>
                                    <div class="flex-1">
                                        <div class="font-bold text-gray-800 mb-1">ส่งข้อมูลให้ Admin</div>
                                        <div class="text-sm text-gray-500 mb-3">แจ้ง Admin ให้ทราบโดยส่งข้อมูลดังนี้</div>
                                        <div class="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2.5">
                                            <div class="flex items-center gap-3">
                                                <div class="w-6 h-6 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                                                    <svg class="w-3.5 h-3.5 text-red-500" viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z"/><path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z"/></svg>
                                                </div>
                                                <div>
                                                    <div class="text-xs text-gray-400 font-bold">Gmail Address</div>
                                                    <div class="text-sm font-bold text-gray-800">yourname@gmail.com</div>
                                                </div>
                                            </div>
                                            <div class="flex items-center gap-3">
                                                <div class="w-6 h-6 bg-yellow-100 rounded-full flex items-center justify-center flex-shrink-0">
                                                    <svg class="w-3.5 h-3.5 text-yellow-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg>
                                                </div>
                                                <div>
                                                    <div class="text-xs text-gray-400 font-bold">App Password (16 หลัก)</div>
                                                    <div class="text-sm font-bold text-yellow-700 tracking-widest font-mono">xxxx xxxx xxxx xxxx</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                            </div><!-- end steps -->

                            <!-- Footer note -->
                            <div class="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
                                <div class="text-xs text-gray-400">รหัสผ่านนี้ใช้ในการเชื่อมต่อ Gmail ชั่วคราว (ไม่ใช่รหัสผ่าน Gmail จริงของคุณ)</div>
                                <a href="https://support.google.com/accounts/answer/185833" target="_blank" class="text-blue-600 text-xs font-bold hover:underline flex items-center gap-1">อ่านคู่มือ Google อีกครั้ง →</a>
                            </div>

                        </div><!-- end guide content -->
                    </div>
                </div><!-- end guide section -->
 
                <!-- แสดงผลตาราง (Desktop) หรือการ์ด (Mobile) -->
                <!-- ตารางอีเมล (Desktop - lg ขึ้นไป) -->
                <div class="hidden lg:block bg-white rounded-2xl shadow-sm border border-gray-200 overflow-x-auto">
                    <table class="w-full text-left min-w-[900px]">
                        <thead class="bg-gray-50 text-gray-600 border-b border-gray-200">
                            <tr>
                                <th class="p-5 font-bold text-sm">บัญชีอีเมล</th>
                                <th class="p-5 font-bold text-sm text-center">สถานะบริการ</th>
                                <th class="p-5 font-bold text-sm text-center">จัดการบริการ</th>
                                <th class="p-5 font-bold text-sm text-center">รหัส PIN ความปลอดภัย</th>
                                <th class="p-5 font-bold text-sm text-center">จัดการลบ</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template x-for="e in paginatedEmails" :key="e.id">
                                <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                                    <td class="p-5 font-bold text-gray-800 text-lg" x-text="e.email"></td>
                                    
                                    <td class="p-5 text-center">
                                        <button @click="e.isActive = !e.isActive; saveEmail(e)" 
                                                :class="e.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'" 
                                                class="px-4 py-2 rounded-full text-xs font-bold shadow-sm transition-all hover:scale-105 flex items-center mx-auto space-x-1">
                                                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
                                                <span x-text="e.isActive ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                                        </button>
                                    </td>
                                    
                                    <td class="p-5">
                                        <div class="flex justify-center gap-2">
                                            <button @click="e.services.disney = !e.services.disney; saveEmail(e)" :class="e.services.disney?'bg-blue-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Disney</button>
                                            <button @click="e.services.chatgpt = !e.services.chatgpt; saveEmail(e)" :class="e.services.chatgpt?'bg-emerald-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">GPT</button>
                                            <button @click="e.services.trueid = !e.services.trueid; saveEmail(e)" :class="e.services.trueid?'bg-red-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">TrueID</button>
                                            <button @click="e.services.youku = !e.services.youku; saveEmail(e)" :class="e.services.youku?'bg-sky-500 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Youku</button>
                                        </div>
                                    </td>
                                    
                                    <td class="p-5">
                                        <div class="flex justify-center items-center space-x-2">
                                            <input type="text" x-model="e.pin" maxlength="6" placeholder="ไม่ตั้ง PIN" class="border border-gray-300 rounded-lg p-2 w-28 text-center font-bold tracking-widest text-sm outline-none focus:border-blue-500 bg-white">
                                            <button @click="saveEmail(e)" class="bg-gray-800 hover:bg-black text-white px-3 py-2 rounded-lg text-xs font-bold transition-all">บันทึก</button>
                                        </div>
                                    </td>
                                    
                                    <td class="p-5 text-center">
                                        <button @click="deleteEmail(e.id)" class="text-red-500 hover:text-red-700 p-2 rounded-lg transition-all mx-auto block">
                                            <svg class="w-5 h-5 mx-auto" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                                        </button>
                                    </td>
                                </tr>
                            </template>
                            <tr x-show="paginatedEmails.length === 0">
                                <td colspan="5" class="p-8 text-center text-gray-400 font-bold">ยังไม่มีรายชื่ออีเมลในระบบนี้</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- การ์ดรายการอีเมล (Mobile - lg ลงไป) -->
                <div class="lg:hidden grid grid-cols-1 gap-4">
                    <template x-for="e in paginatedEmails" :key="e.id">
                        <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 flex flex-col space-y-4 relative">
                            <div class="flex justify-between items-start">
                                <div class="break-all font-bold text-gray-800 text-base pr-8" x-text="e.email"></div>
                                <button @click="deleteEmail(e.id)" class="text-red-500 hover:text-red-700 p-2 rounded-lg transition-all absolute top-3 right-3">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                                </button>
                            </div>
                            
                            <div class="flex items-center justify-between border-t border-gray-100 pt-3">
                                <span class="text-sm font-bold text-gray-500">สถานะบริการ</span>
                                <button @click="e.isActive = !e.isActive; saveEmail(e)" 
                                        :class="e.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'" 
                                        class="px-4 py-2 rounded-full text-xs font-bold shadow-sm transition-all hover:scale-105 flex items-center space-x-1">
                                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
                                        <span x-text="e.isActive ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                                </button>
                            </div>
                            
                            <div class="flex flex-col space-y-2 border-t border-gray-100 pt-3">
                                <span class="text-sm font-bold text-gray-500">จัดการบริการ</span>
                                <div class="grid grid-cols-4 gap-1.5">
                                    <button @click="e.services.disney = !e.services.disney; saveEmail(e)" :class="e.services.disney?'bg-blue-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="py-2 rounded-lg text-[10px] font-bold transition-all text-center">Disney</button>
                                    <button @click="e.services.chatgpt = !e.services.chatgpt; saveEmail(e)" :class="e.services.chatgpt?'bg-emerald-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="py-2 rounded-lg text-[10px] font-bold transition-all text-center">GPT</button>
                                    <button @click="e.services.trueid = !e.services.trueid; saveEmail(e)" :class="e.services.trueid?'bg-red-600 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="py-2 rounded-lg text-[10px] font-bold transition-all text-center">TrueID</button>
                                    <button @click="e.services.youku = !e.services.youku; saveEmail(e)" :class="e.services.youku?'bg-sky-500 text-white shadow-sm':'bg-gray-200 text-gray-500'" class="py-2 rounded-lg text-[10px] font-bold transition-all text-center">Youku</button>
                                </div>
                            </div>

                            <div class="flex flex-col space-y-2 border-t border-gray-100 pt-3">
                                <span class="text-sm font-bold text-gray-500">รหัส PIN ความปลอดภัย</span>
                                <div class="flex items-center space-x-2">
                                    <input type="text" x-model="e.pin" maxlength="6" placeholder="ไม่ตั้ง PIN" class="border border-gray-300 rounded-lg p-2.5 flex-1 text-center font-bold tracking-widest text-sm outline-none focus:border-blue-500 bg-white">
                                    <button @click="saveEmail(e)" class="bg-gray-800 hover:bg-black text-white px-3 py-2.5 rounded-lg text-xs font-bold transition-all shrink-0">บันทึก</button>
                                </div>
                            </div>
                        </div>
                    </template>
                    <div x-show="filteredEmails.length === 0" class="text-center text-gray-400 py-10 font-bold bg-white rounded-2xl border border-gray-200 border-dashed">ยังไม่มีรายชื่ออีเมลในระบบนี้</div>
                </div>

                <!-- Pagination for Emails -->
                <div x-show="totalEmailPages > 1" class="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6 bg-white p-3 rounded-xl shadow-sm border border-gray-200">
                    <div class="text-xs font-bold text-gray-500">
                        แสดงหน้า <span x-text="emailPage"></span> จาก <span x-text="totalEmailPages"></span> (ทั้งหมด <span x-text="filteredEmails.length"></span> รายการ)
                    </div>
                    <div class="flex items-center space-x-1">
                        <button @click="emailPage = 1" :disabled="emailPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">หน้าแรก</button>
                        <button @click="if(emailPage > 1) emailPage--" :disabled="emailPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ก่อนหน้า</button>
                        
                        <template x-for="p in visibleEmailPages" :key="p">
                            <button @click="emailPage = p" 
                                    :class="emailPage === p ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'" 
                                    class="w-8 h-8 rounded-lg border font-bold text-xs flex items-center justify-center transition-colors"
                                    x-text="p"></button>
                        </template>
                        
                        <button @click="if(emailPage < totalEmailPages) emailPage++" :disabled="emailPage === totalEmailPages" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ถัดไป</button>
                    </div>
                </div>
            </div>

                        <!-- Tab: Inbox -->
            <div x-show="tab === 'inbox'" class="p-4 md:p-6 max-w-4xl mx-auto">
                <h1 class="text-2xl md:text-3xl font-bold mb-6 md:mb-8 text-gray-800 border-b pb-4 flex items-center space-x-3"><svg class="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-17.5 0V6.75A2.25 2.25 0 016.375 4.5h11.25a2.25 2.25 0 012.25 2.25v6.75m-17.625 0h-.375a2.25 2.25 0 00-2.25 2.25v1.5a2.25 2.25 0 002.25 2.25h19.5a2.25 2.25 0 002.25-2.25v-1.5a2.25 2.25 0 00-2.25-2.25h-.375" /></svg><span>กล่องจดหมาย (รวมทั้งหมด)</span></h1>
                
                <div class="bg-white p-3 rounded-xl shadow-sm border border-gray-200 mb-4">
                    <input type="text" x-model="searchInbox" @input="inboxPage = 1" placeholder="กรอกอีเมลที่ต้องการค้นหา" class="w-full p-2.5 rounded-lg outline-none font-medium text-gray-700">
                </div>
 
                <div class="space-y-4">
                    <template x-for="msg in paginatedInbox" :key="msg.id">
                        <div class="bg-white p-3 rounded-xl shadow-sm border border-gray-200 flex flex-col relative hover:shadow-md transition-shadow">
                            <div class="flex items-start justify-between mb-1.5">
                                <div class="text-sm flex-1 min-w-0 pr-2">
                                    <div class="font-bold text-gray-800 break-all text-xs leading-5"><span class="text-blue-500 font-bold">ผู้ส่ง:</span> <span x-text="msg.from"></span></div>
                                    <div class="font-bold text-gray-800 break-all text-xs leading-5"><span class="text-red-500 font-bold">ผู้รับ:</span> <span x-text="msg.to"></span></div>
                                </div>
                                <div class="flex items-center gap-1.5 flex-shrink-0">
                                    <div class="text-xs text-gray-500 font-bold bg-gray-100 px-2 py-1 rounded-lg flex items-center">
                                        <svg class="w-3 h-3 mr-1 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        <span x-text="msg.time" class="text-[10px]"></span>
                                    </div>
                                    <button @click="deleteInbox(msg.id)" class="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 p-1.5 rounded-lg transition-all" title="ลบข้อความนี้">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                                    </button>
                                </div>
                            </div>
                            <div class="text-xs font-bold text-gray-500 mb-1.5 border-t pt-1.5" x-text="'หัวข้อ: ' + msg.subject"></div>
                            <div class="text-gray-600 bg-blue-50/50 p-2.5 rounded-lg border border-blue-100 font-medium text-xs whitespace-pre-wrap break-all max-h-20 overflow-y-auto" x-text="msg.message"></div>
                        </div>
                    </template>
                    <div x-show="filteredInbox.length === 0" class="text-center text-gray-400 py-10 font-bold bg-white rounded-2xl border border-gray-200 border-dashed">ไม่พบข้อความอีเมล</div>
                </div>

                <!-- Pagination for Inbox -->
                <div x-show="totalInboxPages > 1" class="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6 bg-white p-3 rounded-xl shadow-sm border border-gray-200">
                    <div class="text-xs font-bold text-gray-500">
                        แสดงหน้า <span x-text="inboxPage"></span> จาก <span x-text="totalInboxPages"></span> (ทั้งหมด <span x-text="filteredInbox.length"></span> รายการ)
                    </div>
                    <div class="flex items-center space-x-1">
                        <button @click="inboxPage = 1" :disabled="inboxPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">หน้าแรก</button>
                        <button @click="if(inboxPage > 1) inboxPage--" :disabled="inboxPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ก่อนหน้า</button>
                        
                        <template x-for="p in visibleInboxPages" :key="p">
                            <button @click="inboxPage = p" 
                                    :class="inboxPage === p ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'" 
                                    class="w-8 h-8 rounded-lg border font-bold text-xs flex items-center justify-center transition-colors"
                                    x-text="p"></button>
                        </template>
                        
                        <button @click="if(inboxPage < totalInboxPages) inboxPage++" :disabled="inboxPage === totalInboxPages" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ถัดไป</button>
                    </div>
                </div>
            </div>

                        <!-- Tab: History -->
            <div x-show="tab === 'history'" class="p-4 md:p-6 max-w-4xl mx-auto">
                <h1 class="text-2xl md:text-3xl font-bold mb-6 md:mb-8 text-gray-800 border-b pb-4 flex items-center space-x-3"><svg class="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg><span>ประวัติการทำรายการ / ค้นหา OTP</span></h1>
                
                <div class="bg-white p-3 rounded-xl shadow-sm border border-gray-200 mb-4">
                    <input type="text" x-model="searchHistory" @input="historyPage = 1" placeholder="กรอกอีเมลที่ต้องการค้นหา" class="w-full p-2.5 rounded-lg outline-none font-medium text-gray-700">
                </div>
 
                <!-- ตารางประวัติ (Desktop) -->
                <div class="hidden md:block bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <table class="w-full text-left table-fixed">
                        <colgroup>
                            <col class="w-36">
                            <col class="w-auto">
                            <col class="w-24">
                            <col class="w-20">
                            <col class="w-28">
                        </colgroup>
                        <thead class="bg-gray-50 text-gray-600 border-b border-gray-200">
                            <tr>
                                <th class="p-3 font-bold text-xs">วันที่ / เวลา</th>
                                <th class="p-3 font-bold text-xs">บัญชีอีเมล</th>
                                <th class="p-3 font-bold text-xs">ชื่ออุปกรณ์</th>
                                <th class="p-3 font-bold text-xs text-center">บริการ</th>
                                <th class="p-3 font-bold text-xs text-center">รหัสที่แสดง</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template x-for="h in paginatedHistory">
                                <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                                    <td class="p-3 text-xs font-medium text-gray-500 whitespace-nowrap overflow-hidden" x-text="h.time"></td>
                                    <td class="p-3 font-bold text-gray-800 text-sm overflow-hidden"><div class="truncate" x-text="h.email" :title="h.email"></div></td>
                                    <td class="p-3 font-bold text-gray-700 text-sm overflow-hidden"><div class="truncate" x-text="h.device" :title="h.device"></div></td>
                                    <td class="p-3 font-bold text-gray-700 text-xs text-center capitalize" x-text="h.service"></td>
                                    <td class="p-3 font-black tracking-widest text-lg text-emerald-600 text-center" x-text="h.otp"></td>
                                </tr>
                            </template>
                            <tr x-show="filteredHistory.length === 0">
                                <td colspan="5" class="p-8 text-center text-gray-400 font-bold">ไม่พบประวัติการค้นหา</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
 
                <!-- การ์ดประวัติ (Mobile - md ลงไป) -->
                <div class="md:hidden grid grid-cols-1 gap-3">
                    <template x-for="h in paginatedHistory">
                        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-col space-y-2">
                            <div class="flex justify-between items-center text-xs text-gray-500">
                                <span x-text="h.time" class="font-medium"></span>
                                <span class="font-bold uppercase px-2 py-0.5 bg-gray-100 rounded text-gray-700 text-[10px]" x-text="h.service"></span>
                            </div>
                            <div class="border-t border-gray-50 pt-2 flex flex-col space-y-1">
                                <div class="text-sm font-bold text-gray-800 break-all"><span class="text-gray-400 font-normal text-xs inline-block w-14">อีเมล:</span> <span x-text="h.email"></span></div>
                                <div class="text-sm font-bold text-gray-700 break-all"><span class="text-gray-400 font-normal text-xs inline-block w-14">อุปกรณ์:</span> <span x-text="h.device"></span></div>
                            </div>
                            <div class="border-t border-gray-50 pt-2 flex justify-between items-center">
                                <span class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">รหัสที่ดึงได้:</span>
                                <span class="text-2xl font-black tracking-widest text-emerald-600" x-text="h.otp"></span>
                            </div>
                        </div>
                    </template>
                    <div x-show="filteredHistory.length === 0" class="text-center text-gray-400 py-10 font-bold bg-white rounded-2xl border border-gray-200 border-dashed">ไม่พบประวัติการค้นหา</div>
                </div>

                <!-- Pagination for History -->
                <div x-show="totalHistoryPages > 1" class="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6 bg-white p-3 rounded-xl shadow-sm border border-gray-200">
                    <div class="text-xs font-bold text-gray-500">
                        แสดงหน้า <span x-text="historyPage"></span> จาก <span x-text="totalHistoryPages"></span> (ทั้งหมด <span x-text="filteredHistory.length"></span> รายการ)
                    </div>
                    <div class="flex items-center space-x-1">
                        <button @click="historyPage = 1" :disabled="historyPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">หน้าแรก</button>
                        <button @click="if(historyPage > 1) historyPage--" :disabled="historyPage === 1" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ก่อนหน้า</button>
                        
                        <template x-for="p in visibleHistoryPages" :key="p">
                            <button @click="historyPage = p" 
                                    :class="historyPage === p ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'" 
                                    class="w-8 h-8 rounded-lg border font-bold text-xs flex items-center justify-center transition-colors"
                                    x-text="p"></button>
                        </template>
                        
                        <button @click="if(historyPage < totalHistoryPages) historyPage++" :disabled="historyPage === totalHistoryPages" class="px-2.5 py-1.5 rounded-lg border border-gray-200 font-bold text-xs bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">ถัดไป</button>
                    </div>
                </div>
            </div>

            <!-- Tab: Settings -->
            <div x-show="tab === 'settings'" class="p-4 md:p-8 max-w-4xl mx-auto">
                <h1 class="text-2xl md:text-3xl font-bold mb-6 md:mb-8 text-gray-800 border-b pb-4 flex items-center space-x-3"><svg class="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg><span>ตั้งค่าระบบหลังบ้าน</span></h1>
                
                <div class="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-200 mb-8">
                    <h2 class="text-xl font-bold mb-6 text-gray-800">จัดการบริการ</h2>
                    
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div class="flex items-center justify-between p-4 border border-gray-100 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                            <span class="font-bold text-gray-700 text-lg">Disney+</span>
                            <button @click="db.globalSettings.disney = !db.globalSettings.disney; saveSettings()" 
                                    :class="db.globalSettings.disney ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-200'" 
                                    class="px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all">
                                <span x-text="db.globalSettings.disney ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                            </button>
                        </div>
                        <div class="flex items-center justify-between p-4 border border-gray-100 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                            <span class="font-bold text-gray-700 text-lg">ChatGPT</span>
                            <button @click="db.globalSettings.chatgpt = !db.globalSettings.chatgpt; saveSettings()" 
                                    :class="db.globalSettings.chatgpt ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-200'" 
                                    class="px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all">
                                <span x-text="db.globalSettings.chatgpt ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                            </button>
                        </div>
                        <div class="flex items-center justify-between p-4 border border-gray-100 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                            <span class="font-bold text-gray-700 text-lg">TrueID</span>
                            <button @click="db.globalSettings.trueid = !db.globalSettings.trueid; saveSettings()" 
                                    :class="db.globalSettings.trueid ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-200'" 
                                    class="px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all">
                                <span x-text="db.globalSettings.trueid ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                            </button>
                        </div>
                        <div class="flex items-center justify-between p-4 border border-gray-100 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                            <span class="font-bold text-gray-700 text-lg">Youku</span>
                            <button @click="db.globalSettings.youku = !db.globalSettings.youku; saveSettings()" 
                                    :class="db.globalSettings.youku ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-200'" 
                                    class="px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all">
                                <span x-text="db.globalSettings.youku ? 'เปิดให้บริการ' : 'ปิดให้บริการ'"></span>
                            </button>
                        </div>
                    </div>
                </div>
 
                <div class="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-200 mb-8">
                    <h2 class="text-xl font-bold mb-4 text-gray-800">แบนเนอร์หน้าแรก</h2>
                    <div class="space-y-4">
                        <div>
                            <label class="text-sm font-bold text-gray-600 block mb-1">ลิงก์รูปภาพแบนเนอร์หน้าแรก | ขนาด 160 x 600 px</label>
                            <div class="space-y-3">
                                <div class="flex items-center gap-3">
                                    <input type="file" id="banner-file-input" accept="image/*" class="hidden" @change="onBannerFileSelected($event)">
                                    <button type="button" @click="document.getElementById('banner-file-input').click()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 px-5 rounded-xl border border-gray-300 transition-all text-sm shadow-sm flex items-center space-x-2">
                                        <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                                        <span>เลือกไฟล์รูปภาพแบนเนอร์</span>
                                    </button>
                                    <span class="text-sm font-medium text-gray-500 break-all" x-text="bannerFileName"></span>
                                </div>
                                <template x-if="bannerImageData || db.globalSettings.bannerUrl">
                                    <div class="mt-3">
                                        <span class="text-xs text-gray-400 block mb-1">ตัวอย่างภาพแบนเนอร์:</span>
                                        <img :src="bannerImageData || db.globalSettings.bannerUrl" class="max-w-xs h-auto max-h-32 object-cover rounded-xl border border-gray-200 shadow-sm" />
                                    </div>
                                </template>
                            </div>
                        </div>
                        <div class="pt-2">
                            <button @click="uploadBanner()" class="bg-gray-800 hover:bg-black text-white font-bold py-3.5 rounded-xl shadow-md active:scale-95 transition-all w-full text-center">บันทึกรูปภาพแบนเนอร์</button>
                        </div>
                    </div>
                </div>

                <div class="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-200 relative overflow-hidden">
                    <h2 class="text-xl font-bold mb-6 text-gray-800">ตั้งค่าผู้ดูแลระบบ</h2>
                    
                    <div class="space-y-4 max-w-md">
                        <div>
                            <label class="text-sm font-bold text-gray-600 block mb-1">Username / ชื่อผู้ใช้งาน</label>
                            <input type="text" x-model="newAdminUser" class="w-full p-3 border border-gray-300 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 font-medium text-gray-800">
                        </div>
                        <div>
                            <label class="text-sm font-bold text-gray-600 block mb-1">Password / รหัสผ่าน</label>
                            <input type="text" x-model="newAdminPass" class="w-full p-3 border border-gray-300 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 font-medium text-gray-800">
                        </div>
                        <div class="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                            <button @click="updateAdmin" class="bg-gray-800 hover:bg-black text-white font-bold py-3 px-8 rounded-xl shadow-md active:scale-95 transition-all">บันทึกการเปลี่ยนแปลงข้อมูล</button>
                            <span x-show="adminSaved" class="text-emerald-600 font-bold bg-emerald-50 px-3 py-1 rounded-lg text-center">บันทึกสำเร็จแล้ว!</span>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    </div>

    <script>
        document.addEventListener('alpine:init', () => {
            Alpine.data('adminApp', () => ({
                isLoggedIn: false, loginUser: '', loginPass: '', loginError: false,
                tab: 'dashboard', emailTab: 'Gmail', searchEmail: '', searchInbox: '', searchHistory: '', newEmail: '',
                db: { emails: [], history: [], inbox: [], globalSettings: {} },
                newAdminUser: '', newAdminPass: '', adminSaved: false, mobileMenuOpen: false,
                inboxPage: 1, inboxPerPage: 10,
                historyPage: 1, historyPerPage: 10,
                emailPage: 1, emailPerPage: 10,
                bannerFileName: 'ยังไม่ได้เลือกไฟล์', bannerImageData: '', showGmailGuide: false,

                async login() {
                    const res = await fetch('/api/admin/login', {
                        method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({username: this.loginUser, password: this.loginPass})
                    });
                    const data = await res.json();
                    if(data.success) { this.isLoggedIn = true; this.loginError = false; this.loadData(); }
                    else { this.loginError = true; }
                },
                logout() { this.isLoggedIn = false; this.loginUser = ''; this.loginPass = ''; },
                async loadData() {
                    const res = await fetch('/api/admin/data');
                    this.db = await res.json();
                    this.newAdminUser = this.db.admin.username;
                    this.newAdminPass = this.db.admin.password;
                },
                
                countAppDaily(app) { 
                    const today = new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
                    return this.db.history.filter(h => h.service === app && (h.dateStr === today || (h.time && h.time.includes(today)))).length; 
                },
                parseDate(dateStr) {
                    if (!dateStr) return new Date();
                    const parts = dateStr.split(' ');
                    const dateParts = parts[0].split('/');
                    let day = parseInt(dateParts[0]);
                    let month = parseInt(dateParts[1]) - 1;
                    let year = parseInt(dateParts[2]);
                    if (year > 2400) year -= 543;
                    
                    let hour = 0, minute = 0, second = 0;
                    if (parts[1]) {
                        const timeParts = parts[1].split(':');
                        hour = parseInt(timeParts[0]) || 0;
                        minute = parseInt(timeParts[1]) || 0;
                        second = parseInt(timeParts[2]) || 0;
                    }
                    return new Date(year, month, day, hour, minute, second);
                },
                countAppWeekly(app) {
                    const sevenDaysAgo = new Date();
                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                    return this.db.history.filter(h => h.service === app && this.parseDate(h.time) >= sevenDaysAgo).length;
                },
                countAppMonthly(app) {
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    return this.db.history.filter(h => h.service === app && this.parseDate(h.time) >= thirtyDaysAgo).length;
                },
                
                get filteredEmails() {
                    return this.db.emails.filter(e => e.system === this.emailTab && e.email.toLowerCase().includes(this.searchEmail.toLowerCase()));
                },
                get paginatedEmails() {
                    const start = (this.emailPage - 1) * this.emailPerPage;
                    return this.filteredEmails.slice(start, start + this.emailPerPage);
                },
                get totalEmailPages() {
                    return Math.ceil(this.filteredEmails.length / this.emailPerPage) || 1;
                },
                get visibleEmailPages() {
                    return this.getVisiblePages(this.emailPage, this.totalEmailPages);
                },
                onBannerFileSelected(event) {
                    const file = event.target.files[0];
                    if (file) {
                        this.bannerFileName = file.name;
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            this.bannerImageData = e.target.result;
                        };
                        reader.readAsDataURL(file);
                    }
                },
                async uploadBanner() {
                    if (!this.bannerImageData) {
                        alert('กรุณาเลือกไฟล์รูปภาพแบนเนอร์ก่อนกดบันทึก');
                        return;
                    }
                    try {
                        const res = await fetch('/api/admin/upload-banner', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ image: this.bannerImageData })
                        });
                        const data = await res.json();
                        if (data.success) {
                            this.db.globalSettings.bannerUrl = data.bannerUrl;
                            this.bannerImageData = '';
                            this.bannerFileName = 'ยังไม่ได้เลือกไฟล์';
                            alert('บันทึกรูปภาพแบนเนอร์สำเร็จแล้ว!');
                            this.loadData();
                        } else {
                            alert('เกิดข้อผิดพลาด: ' + data.error);
                        }
                    } catch (err) {
                        alert('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์: ' + err.message);
                    }
                },
                async saveEmail(emailObj) {
                    await fetch('/api/admin/update-email', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(emailObj) });
                },
                async addEmail() {
                    if (!this.newEmail) return;
                    await fetch('/api/admin/add-email', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: this.newEmail.trim(), system: this.emailTab }) });
                    this.newEmail = ''; this.loadData();
                },
                async deleteEmail(id) {
                    if (!confirm('ยืนยันการลบอีเมลนี้ออกจากระบบใช่หรือไม่?')) return;
                    await fetch('/api/admin/delete-email', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                    this.loadData();
                },

                get filteredInbox() {
                    return this.db.inbox.filter(m => m.from.includes(this.searchInbox) || m.to.includes(this.searchInbox) || m.subject.includes(this.searchInbox) || m.message.includes(this.searchInbox));
                },
                get paginatedInbox() {
                    const start = (this.inboxPage - 1) * this.inboxPerPage;
                    return this.filteredInbox.slice(start, start + this.inboxPerPage);
                },
                get totalInboxPages() {
                    return Math.ceil(this.filteredInbox.length / this.inboxPerPage) || 1;
                },
                get visibleInboxPages() {
                    return this.getVisiblePages(this.inboxPage, this.totalInboxPages);
                },
                async deleteInbox(id) {
                    if(!confirm('ยืนยันการลบข้อความนี้?')) return;
                    await fetch('/api/admin/delete-inbox', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                    this.loadData();
                },

                get filteredHistory() {
                    return this.db.history.filter(h => h.email.toLowerCase().includes(this.searchHistory.toLowerCase()) || (h.device && h.device.toLowerCase().includes(this.searchHistory.toLowerCase())));
                },
                get paginatedHistory() {
                    const start = (this.historyPage - 1) * this.historyPerPage;
                    return this.filteredHistory.slice(start, start + this.historyPerPage);
                },
                get totalHistoryPages() {
                    return Math.ceil(this.filteredHistory.length / this.historyPerPage) || 1;
                },
                get visibleHistoryPages() {
                    return this.getVisiblePages(this.historyPage, this.totalHistoryPages);
                },
                getVisiblePages(current, total) {
                    const pages = [];
                    const maxVisible = 5;
                    let start = Math.max(1, current - 2);
                    let end = Math.min(total, start + maxVisible - 1);
                    if (end - start + 1 < maxVisible) {
                        start = Math.max(1, end - maxVisible + 1);
                    }
                    for (let i = start; i <= end; i++) {
                        pages.push(i);
                    }
                    return pages;
                },

                async saveSettings() {
                    await fetch('/api/admin/save-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({settings: this.db.globalSettings}) });
                },
                async updateAdmin() {
                    await fetch('/api/admin/update-admin', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username: this.newAdminUser, password: this.newAdminPass}) });
                    this.adminSaved = true; setTimeout(()=>this.adminSaved=false, 3000);
                }
            }))
        })
    </script>
</body>
</html>`);
});

app.listen(port, () => {
    console.log(`===========================================`);
    console.log(`🚀 Server และ Admin Panel เปิดทำงานแล้วที่พอร์ต ${port}!`);
    console.log(`🌐 เข้าหน้าลูกค้าที่: http://localhost:${port}/`);
    console.log(`⚙️ เข้าหน้าแอดมินที่: http://localhost:${port}/admin`);
    console.log(`===========================================`);
});