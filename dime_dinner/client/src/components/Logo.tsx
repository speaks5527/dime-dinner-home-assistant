/** Dime Dinner mark: a coin-plate — a dime-sized circle over a plate rim, with a fork tine. */
export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Dime Dinner logo"
      data-testid="img-logo"
    >
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="7.5" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
      <path d="M16 8.5v15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.4 8.5v4.2a1.9 1.9 0 0 0 3.6 0V8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M19.6 23.5v-6.2c1.6-.5 2.4-1.8 2.4-4.1V8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function LogoWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-primary">
        <Logo className="h-7 w-7" />
      </span>
      {!compact && (
        <span className="font-display text-lg font-semibold leading-none tracking-tight">
          Dime<span className="text-primary">Dinner</span>
        </span>
      )}
    </div>
  );
}
