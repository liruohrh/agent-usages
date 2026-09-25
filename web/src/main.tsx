/**
 * The browser entry point.
 *
 * `BrowserRouter` (not hash routing) because the server answers any unknown GET
 * with the app shell, so `/p/<id>` is a real URL that survives a refresh.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './index.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
