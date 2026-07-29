import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Lightbulb, LightbulbOff, X } from "lucide-react";
import { RecipeImage } from "@/components/RecipeBits";
import { RecimeExportMenu } from "@/components/RecimeExportMenu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { flattenSteps } from "@/lib/steps";
import type { RecipeDTO } from "@shared/schema";

/** Wake Lock with graceful fallback for browsers that do not support it. */
function useWakeLock() {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [enabled, setEnabled] = useState(false);
  const sentinel = useRef<any>(null);
  const { toast } = useToast();

  const release = async () => {
    try {
      await sentinel.current?.release?.();
    } catch {
      /* ignore */
    }
    sentinel.current = null;
    setEnabled(false);
  };

  const request = async () => {
    if (!supported) {
      toast({
        title: "Keep-awake not available",
        description: "This browser does not support the Wake Lock API. Adjust your device sleep settings instead.",
      });
      return;
    }
    try {
      sentinel.current = await (navigator as any).wakeLock.request("screen");
      sentinel.current.addEventListener?.("release", () => setEnabled(false));
      setEnabled(true);
    } catch {
      toast({ title: "Could not keep the screen awake", description: "The browser refused the request." });
    }
  };

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && enabled && !sentinel.current) void request();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel.current?.release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { supported, enabled, toggle: () => (enabled ? release() : request()) };
}

export default function CookPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: recipe, isLoading } = useQuery<RecipeDTO>({ queryKey: ["/api/recipes", id] });
  const [index, setIndex] = useState(0);
  const [showIngredients, setShowIngredients] = useState(false);
  const wakeLock = useWakeLock();

  const steps = useMemo(() => (recipe ? flattenSteps(recipe.instructions) : []), [recipe]);
  const step = steps[index];
  const total = steps.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        setIndex((i) => Math.min(i + 1, Math.max(total - 1, 0)));
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (event.key.toLowerCase() === "i") {
        setShowIngredients((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <Skeleton className="h-full min-h-[70vh] w-full rounded-lg" />
      </div>
    );
  }

  if (!recipe || total === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <h1 className="font-display text-xl font-semibold">No steps to cook</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This recipe did not include instruction steps. Open the original page for the full method.
        </p>
        <Link href={recipe ? `/recipes/${recipe.id}` : "/"}>
          <Button variant="secondary" data-testid="button-exit-cook">
            Back to recipe
          </Button>
        </Link>
      </div>
    );
  }

  const stepImage = step.image ?? recipe.imageUrl;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground" data-testid="view-cooking-mode">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Cooking mode</p>
          <h1 className="truncate font-display text-base font-semibold" data-testid="text-cook-title">
            {recipe.title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="hidden sm:block">
            <RecimeExportMenu recipe={recipe} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => wakeLock.toggle()}
            aria-pressed={wakeLock.enabled}
            title={wakeLock.supported ? "Keep the screen awake" : "Wake Lock unsupported in this browser"}
            data-testid="button-wake-lock"
          >
            {wakeLock.enabled ? <Lightbulb className="h-4 w-4 text-primary" /> : <LightbulbOff className="h-4 w-4" />}
            <span className="ml-1.5 hidden sm:inline">{wakeLock.enabled ? "Screen on" : "Keep awake"}</span>
          </Button>
          <Link href={`/recipes/${recipe.id}`}>
            <Button variant="ghost" size="icon" aria-label="Exit cooking mode" data-testid="button-close-cook">
              <X className="h-5 w-5" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Progress */}
      <div className="h-1 w-full bg-muted" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={total}>
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${((index + 1) / total) * 100}%` }}
          data-testid="progress-cook"
        />
      </div>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:items-start lg:gap-10 lg:py-10">
        <RecipeImage
          src={stepImage}
          alt={recipe.title}
          className="h-48 w-full rounded-lg sm:h-64 lg:h-80 lg:w-[42%]"
          testId="img-cook-step"
        />
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary" data-testid="text-step-counter">
            Step {index + 1} of {total}
            {step.heading ? ` · ${step.heading}` : ""}
          </p>
          <p
            className="mt-3 font-display text-[1.35rem] font-medium leading-[1.5] sm:text-[1.6rem] sm:leading-[1.45]"
            data-testid="text-step"
          >
            {step.text}
          </p>
        </div>
      </main>

      {/* Ingredient reference */}
      <section className="border-t border-border px-4 sm:px-6">
        <button
          type="button"
          onClick={() => setShowIngredients((v) => !v)}
          className="flex w-full items-center justify-between py-3 text-sm font-medium"
          aria-expanded={showIngredients}
          data-testid="button-toggle-ingredients"
        >
          <span className="flex items-center gap-2">
            {showIngredients ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            Ingredients ({recipe.ingredients.length})
          </span>
          <span className="text-xs text-muted-foreground">press I</span>
        </button>
        {showIngredients && (
          <ul className="grid gap-x-8 gap-y-1.5 pb-4 text-sm sm:grid-cols-2" data-testid="list-cook-ingredients">
            {recipe.ingredients.map((line, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        <Button
          variant="secondary"
          size="lg"
          className="flex-1"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(i - 1, 0))}
          data-testid="button-prev-step"
        >
          <ChevronLeft className="mr-1.5 h-5 w-5" /> Previous
        </Button>
        {index === total - 1 ? (
          <Link href={`/recipes/${recipe.id}`} className="flex-1">
            <Button size="lg" className="w-full" data-testid="button-finish-cook">
              Finish
            </Button>
          </Link>
        ) : (
          <Button
            size="lg"
            className="flex-1"
            onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
            data-testid="button-next-step"
          >
            Next <ChevronRight className="ml-1.5 h-5 w-5" />
          </Button>
        )}
      </footer>
    </div>
  );
}
