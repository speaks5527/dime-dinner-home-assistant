import { Clock, Users, UtensilsCrossed } from "lucide-react";
import { Logo } from "@/components/Logo";
import { formatMinutes } from "@/lib/app";
import { cn } from "@/lib/utils";
import type { RecipeDTO } from "@shared/schema";

/** Recipe image with a designed fallback — never a broken image or grey box. */
export function RecipeImage({
  src,
  alt,
  className,
  testId,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  testId?: string;
}) {
  if (!src) {
    return (
      <div
        className={cn(
          "surface-weave flex items-center justify-center bg-muted text-muted-foreground/50",
          className,
        )}
        data-testid={testId}
        aria-label={`${alt} (no image)`}
        role="img"
      >
        <Logo className="h-8 w-8" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn("object-cover", className)}
      data-testid={testId}
      onError={(event) => {
        const el = event.currentTarget;
        el.style.display = "none";
        el.parentElement?.classList.add("surface-weave", "bg-muted");
      }}
    />
  );
}

export function RecipeMeta({ recipe, className }: { recipe: RecipeDTO; className?: string }) {
  const total = formatMinutes(recipe.totalMinutes);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}>
      {total && (
        <span className="inline-flex items-center gap-1.5" data-testid="text-recipe-time">
          <Clock className="h-3.5 w-3.5" />
          {total}
        </span>
      )}
      {recipe.servings && (
        <span className="inline-flex items-center gap-1.5" data-testid="text-recipe-servings">
          <Users className="h-3.5 w-3.5" />
          {recipe.servings}
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <UtensilsCrossed className="h-3.5 w-3.5" />
        {recipe.ingredients.length} ingredients
      </span>
    </div>
  );
}

export function SourceNote({ recipe }: { recipe: RecipeDTO }) {
  const host = (() => {
    try {
      return new URL(recipe.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return recipe.siteName ?? "source";
    }
  })();
  return (
    <p className="text-xs leading-relaxed text-muted-foreground" data-testid="text-attribution">
      Recipe by{" "}
      <a
        href={recipe.sourceUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="font-medium text-primary underline underline-offset-2"
        data-testid="link-recipe-source"
      >
        {recipe.author ? `${recipe.author} · ` : ""}
        {recipe.siteName ?? host}
      </a>
      . Fetched on demand for personal use — Dime Dinner is not affiliated with or endorsed by the publisher.
    </p>
  );
}
