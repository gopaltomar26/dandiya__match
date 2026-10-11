# Dandiya Match – setup (about 10 minutes, all free)

## Files
- `index.html` – user page: name, age, phone, photo upload, then age filter, "I'm interested" and mutual matches
- `admin.html` – owner-only panel: online/offline users, totals, matches, remove user
- `firebase-config.js` – your Firebase keys + your owner email
- `firestore.rules` – security rules (this is what really locks the admin data to you)

## 1. Firebase
1. Go to console.firebase.google.com and create a project.
2. Build > Authentication > Get started. Enable **Anonymous** and **Google** sign-in.
3. Build > Firestore Database > Create database (production mode).
4. Firestore > Rules tab: paste `firestore.rules`, change `you@gmail.com` to your Google email, and Publish.
5. Project settings > Your apps > Web (</>) and copy the config into `firebase-config.js`. Also set `OWNER_EMAIL` there.
6. Authentication > Settings > Authorized domains: add your Vercel domain (e.g. `yoursite.vercel.app`).

## 2. Deploy on Vercel
- Put `index.html`, `admin.html`, `firebase-config.js` at the **root of the GitHub repo** (not inside a subfolder).
  A 404 NOT_FOUND on Vercel usually means index.html is not at the root, or the Root Directory setting points to the wrong folder.
- Framework preset: **Other**. Build command and output directory: leave empty.
- Open `/admin.html` on your site and sign in with your Google account.

## Notes
- Online = heartbeat seen in the last ~70 seconds.
- Photos are shrunk to about 300px and saved inside Firestore, so no paid Storage is needed.
- Phone numbers are visible only to the profile owner, you (admin), and a mutual match.
