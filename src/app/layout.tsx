import type { Metadata } from 'next';
import { THEME_STORAGE_KEY } from './theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Podium',
  description: 'Provider-aware stream checker and reorderer for Dispatcharr',
};

const themeScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script>{themeScript}</script>
      </head>
      <body>{children}</body>
    </html>
  );
}
