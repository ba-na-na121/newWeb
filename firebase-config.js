// Firebase setup shared by password.html and lifestyle.html.
// This config is public by design; what protects the data are the rules in
// firestore.rules and storage.rules, plus the two login accounts below.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyA6RiB-bqTR3on_KpIRARLm0W3SWeYWaz0",
  authDomain: "wenzuoweb.firebaseapp.com",
  projectId: "wenzuoweb",
  storageBucket: "wenzuoweb.appspot.com",
  messagingSenderId: "415514650847",
  appId: "1:415514650847:web:18d293683bfcbea4f9e16a",
  measurementId: "G-MDDZ10S396"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Login accounts (create both in Firebase Console → Authentication → Users).
// These addresses never receive email; they are just usernames.
//  - FRIENDS_EMAIL: shared account. Its password is the one you give to friends. Can only view.
//  - OWNER_EMAIL:   your own account, with a different password. Can post, edit and delete.
// If you change OWNER_EMAIL, change it in firestore.rules and storage.rules too.
export const FRIENDS_EMAIL = "friends@wenzuoweb.firebaseapp.com";
export const OWNER_EMAIL = "owner@wenzuoweb.firebaseapp.com";

export const isOwner = (user) => !!user && user.email === OWNER_EMAIL;
