import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000', // Your FastAPI backend URL
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/join-room': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
      '/start-game': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      }
    },
    port: 3000, // Frontend port
  },
  define: {
    'process.env': {}
  }
});
