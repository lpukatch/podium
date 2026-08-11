import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Podium',
  description: 'Provider-aware stream checker and reorderer for Dispatcharr',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
