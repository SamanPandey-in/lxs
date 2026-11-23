import "./globals.css";
import "./lxs.css";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import Shell from "../components/Shell";

// Loaded explicitly so every machine renders the same face (agents/ui/tokens.md §1).
const sans = Geist({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-jbmono", display: "swap" });

export const metadata = {
  title: "LXS",
  description: "Deception-driven SOC dashboard powered by a honeypot network",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <Shell>{children}</Shell>
        </ThemeProvider>
      </body>
    </html>
  );
}
