//firebase SDK
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword
} from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

 const firebaseConfig = {
    apiKey: "AIzaSyAa3tscObg263CLdVyrUN7ZrB4LbO-1JgQ",
    authDomain: "estilo-hub.firebaseapp.com",
    projectId: "estilo-hub",
    storageBucket: "estilo-hub.firebasestorage.app",
    messagingSenderId: "442111984908",
    appId: "1:442111984908:web:28aa9a2ca682c3174b3529"
  };

const app= initializeApp(firebaseConfig);

const auth= getAuth(app);
const db= getFirestore(app);

export { 
  auth,
  db,
  // createUserwithEmailAndPassword,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
};
