import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles.css';
import './landing.css';
import { LandingApp } from './LandingApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <LandingApp />
    </React.StrictMode>
);
