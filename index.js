 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/index.js b/index.js
index b1b8f9cd2dec2898439bcfb2599533c2ba75f0bf..38f247fd867e2bf6dcf4c23f130db1016c113307 100644
--- a/index.js
+++ b/index.js
@@ -1,35 +1,36 @@
 const express = require('express');
 const cors = require('cors'); // นำเข้าไลบรารี CORS เพื่อแก้ปัญหาบล็อกโดเมน
 const path = require('path');
 const fs = require('fs');
 const imaps = require('imap-simple');
 const simpleParser = require('mailparser').simpleParser;
 const admin = require('firebase-admin');
 
 const app = express();
-const port = process.env.PORT || 3000;
+const port = Number(process.env.PORT || process.env.APP_PORT || 3000);
+const host = process.env.HOST || '0.0.0.0';
 
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
@@ -1657,32 +1658,32 @@ app.get('/admin', (req, res) => {
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
 
-app.listen(port, () => {
+app.listen(port, host, () => {
     console.log(`===========================================`);
-    console.log(`🚀 Server และ Admin Panel เปิดทำงานแล้วที่พอร์ต ${port}!`);
+    console.log(`🚀 Server และ Admin Panel เปิดทำงานแล้วที่ ${host}:${port}!`);
     console.log(`🌐 เข้าหน้าลูกค้าที่: http://localhost:${port}/`);
     console.log(`⚙️ เข้าหน้าแอดมินที่: http://localhost:${port}/admin`);
     console.log(`===========================================`);
 });
\ No newline at end of file
 
EOF
)
