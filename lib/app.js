// The shared Express app; lib/rest.js and lib/dashboard/ register their routes on it at import time.
import express from "express";

// ── Express app ───────────────────────────────────────────────────────────────

export const app = express();
