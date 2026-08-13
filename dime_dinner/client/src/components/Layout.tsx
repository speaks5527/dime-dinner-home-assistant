import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { BookOpen, CalendarDays, ListChecks, Moon, Package, Settings as SettingsIcon, Sun, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { LogoWordmark } from "@/components/Logo";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Recipes", icon: BookOpen, testId: "link-nav-recipes" },
  { href: "/planner", label: "Planner", icon: CalendarDays, testId: "link-nav-planner" },
  { href: "/grocery", label: "Grocery", icon: ListChecks, testId: "link-nav-grocery" },
  { href: "/pantry", label: "Pantry", icon: Package, testId: "link-nav-pantry" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, testId: "link-nav-settings" },
];

export function useTheme() {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false : false,
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return { dark, setDark };
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = item.href === "/" ? location === "/" || location.startsWith("/recipes") : location.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            data-testid={item.testId}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover-elevate",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/75 hover:text-sidebar-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", active && "text-primary")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ThemeToggle({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setDark(!dark)}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      data-testid="button-theme-toggle"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { dark, setDark } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar px-4 py-5 lg:flex">
        <Link href="/" className="mb-7 block" data-testid="link-home">
          <LogoWordmark />
        </Link>
        <NavLinks />
        <div className="mt-auto space-y-3 pt-6">
          <div className="rounded-md border border-sidebar-border bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            Recipes are fetched from their publishers on demand. Browse includes Eating on a Dime, AJ Greats, and KetoFocus. Independent
            tool — not affiliated with any publisher or retailer.
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Appearance</span>
            <ThemeToggle dark={dark} setDark={setDark} />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation" data-testid="button-open-nav">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 bg-sidebar px-4 py-5">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="mb-6">
              <LogoWordmark />
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <Link href="/" data-testid="link-home-mobile">
          <LogoWordmark />
        </Link>
        <ThemeToggle dark={dark} setDark={setDark} />
      </header>

      <main className="lg:pl-60">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="no-print mb-6 flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight" data-testid="text-page-title">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
