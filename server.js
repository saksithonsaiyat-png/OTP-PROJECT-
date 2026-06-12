// นำเข้าไลบรารีที่จำเป็น
const express = require('express');
const cors = require('cors');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const path = require('path'); // เพิ่มบรรทัดนี้เพื่อจัดการที่อยู่ไฟล์

const app = express();
app.use(cors()); // อนุญาตให้หน้าเว็บ (Frontend) ดึงข้อมูลได้

// ========================================================
// 🌐 ส่วนแสดงผลหน้าเว็บ (เอาไว้แก้ Cannot GET /)
// ========================================================
app.use(express.static(__dirname)); // ให้อ่านไฟล์ภาพและ CSS ในโฟลเดอร์นี้ได้
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // สั่งให้แสดงหน้า index.html
});

// ========================================================
// ⚙️ 1. ตั้งค่าบัญชีอีเมลหลักของร้าน (Maily.space)
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

// ========================================================
// 📋 2. ฐานข้อมูลผู้ส่ง OTP ของแต่ละแอป
// ========================================================
const SENDER_EMAILS = {
    'disney': 'disneyplus@mail.disneyplus.com', 
    'chatgpt': 'noreply@openai.com',
    'trueid': 'no-reply@trueid.net',
    'youku': 'no-reply@youku.com'
};

// ========================================================
// 🚀 3. API สำหรับดึง OTP (รับคำสั่งจากหน้าเว็บ)
// ========================================================
app.get('/api/get-otp', async (req, res) => {
    const serviceId = req.query.service; 
    const targetEmail = req.query.email; 

    const senderEmail = SENDER_EMAILS[serviceId];

    if (!senderEmail || !targetEmail) {
        return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบถ้วน หรือไม่รองรับบริการนี้' });
    }

    try {
        console.log(`[${new Date().toLocaleTimeString()}] ⏳ กำลังหา OTP ของ ${serviceId} สำหรับอีเมล ${targetEmail}...`);
        
        // เชื่อมต่อเข้าไปที่ระบบอีเมล
        const connection = await imaps.connect(emailConfig);
        await connection.openBox('INBOX');

        // 🔍 ค้นหาอีเมล: "ยังไม่ได้อ่าน" + "มาจากแอปนั้นๆ" + "ส่งถึงอีเมลที่ลูกค้ากรอก"
        const searchCriteria = [
            'UNSEEN', 
            ['FROM', senderEmail],
            ['TO', targetEmail]
        ];
        
        const fetchOptions = { bodies: ['HEADER', 'TEXT', ''], markSeen: true }; 

        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            connection.end();
            console.log(`❌ ไม่พบอีเมล OTP ใหม่`);
            return res.status(404).json({ success: false, error: 'ยังไม่มีข้อความ OTP เข้ามา กรุณารอสักครู่แล้วลองใหม่' });
        }

        // เอาอีเมลฉบับล่าสุด (ฉบับบนสุด)
        const latestMessage = messages[messages.length - 1];
        const allParts = latestMessage.parts.find(p => p.which === '');
        
        // แปลงร่างอีเมลให้อ่านง่าย
        const parsedMail = await simpleParser(allParts.body);
        const emailBody = parsedMail.text || parsedMail.html || '';

        connection.end(); 

        // ========================================================
        // 🧩 4. สูตรดึงตัวเลข 4 ถึง 6 หลักจากเนื้อหาอีเมล
        // ========================================================
        const otpRegex = /\b\d{4,6}\b/; 
        const match = emailBody.match(otpRegex);

        if (match) {
            console.log(`✅ พบ OTP: ${match[0]}`);
            return res.json({ 
                success: true, 
                code: match[0]
            });
        } else {
            console.log(`❌ หาตัวเลขในอีเมลไม่เจอ`);
            return res.status(500).json({ success: false, error: 'พบอีเมลแต่ไม่สามารถดึงรหัสตัวเลขได้' });
        }

    } catch (error) {
        console.error('🔥 Error:', error.message);
        return res.status(500).json({ success: false, error: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์อีเมลได้ โปรดตรวจสอบการตั้งค่า' });
    }
});

// เปิดรันเซิร์ฟเวอร์ที่พอร์ต 3000
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🚀 เซิร์ฟเวอร์ทำหน้าเว็บ และ OTP ทำงานแล้ว!`);
    console.log(`🔗 เข้าหน้าเว็บได้ที่พอร์ต ${PORT}`);
    console.log(`===========================================`);
});