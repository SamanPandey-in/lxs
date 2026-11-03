import "./globals.css";
import "./lxs.css";
import { ThemeProvider } from "next-themes";
import Shell from "../components/Shell";

export const metadata = {
  title: "LXS",
  description: "Deception-driven SOC dashboard powered by a honeypot network",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <Shell>{children}</Shell>
        </ThemeProvider>
      </body>
    </html>
  );
}
