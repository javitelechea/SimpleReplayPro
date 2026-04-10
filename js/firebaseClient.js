import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
    apiKey: 'AIzaSyBjxEy4e5ha_xP_bjCz7ew5pcw14n3aEVg',
    authDomain: 'simplereplaypro.firebaseapp.com',
    projectId: 'simplereplaypro',
    storageBucket: 'simplereplaypro.firebasestorage.app',
    messagingSenderId: '90726599572',
    appId: '1:90726599572:web:2b079b613c80c9ee801d81',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export { app, db, auth, firebaseConfig };
