 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/index.js b/index.js
index b1b8f9cd2dec2898439bcfb2599533c2ba75f0bf..91f980ebec731b3cf52d46a9ed8decb683c4c6d6 100644
--- a/index.js
+++ b/index.js
@@ -1,35 +1,35 @@
 const express = require('express');
 const cors = require('cors'); // นำเข้าไลบรารี CORS เพื่อแก้ปัญหาบล็อกโดเมน
 const path = require('path');
 const fs = require('fs');
 const imaps = require('imap-simple');
 const simpleParser = require('mailparser').simpleParser;
 const admin = require('firebase-admin');
 
 const app = express();
-const port = process.env.PORT || 3000;
+const port = process.env.APP_PORT || 3000;
 
 // ========================================================
 // ⚙️ ตั้งค่าบัญชีอีเมลหลักของร้าน (Maily.space) - ลิงก์เชื่อมโยงกับฐานข้อมูล
 // ========================================================
 const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
 let firestoreDb = null;
 let isFirebaseActive = false;
 
 // SSE Client list for real-time notifications
 let sseClients = [];
 
 try {
     if (fs.existsSync(serviceAccountPath)) {
         const serviceAccount = require(serviceAccountPath);
         admin.initializeApp({
             credential: admin.credential.cert(serviceAccount)
         });
         firestoreDb = admin.firestore();
         isFirebaseActive = true;
         console.log("🔥 [Firebase] Connected to Firestore successfully!");
         // Run migration in the background
         setTimeout(() => {
             migrateLocalToFirestore();
         }, 1000);
     } else {
 
EOF
)
