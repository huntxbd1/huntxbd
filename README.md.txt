# HUNTX BD Website

## ফাইল
- `index.html` — ইউজার সাইট
- `admin.html` — অ্যাডমিন প্যানেল
- পাসওয়ার্ড: `huntx2026`

## GitHub এ আপলোড
1. নতুন রিপো তৈরি করুন
2. এই তিনটা ফাইল আপলোড করুন (index.html, admin.html, README.md)
3. Commit করুন

## Render এ হোস্ট
1. https://render.com → New → Static Site
2. GitHub রিপো কানেক্ট করুন
3. Build Command: খালি রাখুন
4. Publish Directory: `.` (রুট)
5. Create Static Site

## Firebase (আগে সেট করা)
- Firestore Rules: allow read, write: if true
- Storage: Blaze প্ল্যান + Rules allow read/write
- Direct APK আপলোড অ্যাডমিন থেকে কাজ করবে

## ব্যবহার
- সাইট: আপনার Render URL
- অ্যাডমিন: `https://your-site.onrender.com/admin.html`
