export const metadata = {
  title: '⚡ Attacker Console — LXS demo',
  description: 'Stage prop: fires real attacks at the LXS honeypots for the demo.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0b0d0e' }}>{children}</body>
    </html>
  );
}
