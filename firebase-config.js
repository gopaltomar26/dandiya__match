// Paste your Firebase web-app config here (Firebase console > Project settings > Your apps)
window.FB_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  appId: "YOUR_APP_ID"
};
// Only this Google account can open the admin panel
window.OWNER_EMAIL = "you@gmail.com";

firebase.initializeApp(window.FB_CONFIG);
window.db = firebase.firestore();
window.auth = firebase.auth();
