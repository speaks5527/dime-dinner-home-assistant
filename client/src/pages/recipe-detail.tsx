import { Link, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarPlus, ChefHat, ExternalLink, Heart } from "lucide-react";
import { Layout } from "@/components/Layout";
import { RecipeImage, RecipeMeta, SourceNote } from "@/components/RecipeBits";
import { AddToPlanDialog } from "@/components/AddToPlanDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queryClient } from "@/lib/queryClient";
import { patchJson } from "@/lib/app";
import type { RecipeDTO } from "@shared/schema";

export default function RecipeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: recipe, isLoading, isError } = useQuery<RecipeDTO>({ queryKey: ["/api/recipes", id] });

  const favorite = useMutation({
    mutationFn: () => patchJson<RecipeDTO>(`/api/recipes/${id}`, { favorite: !recipe?.favorite }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipes", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/recipes"] });
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <Skeleton className="mb-6 h-64 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </Layout>
    );
  }

  if (isError || !recipe) {
    return (
      <Layout>
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <h1 className="font-display text-lg font-semibold">Recipe not found</h1>
          <Link href="/">
            <Button className="mt-4" variant="secondary" data-testid="button-back-recipes">
              Back to recipes
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <Link href="/" className="no-print mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back">
        <ArrowLeft className="h-4 w-4" /> Recipes
      </Link>

      <div className="grid gap-8 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <RecipeImage
            src={recipe.imageUrl}
            alt={recipe.title}
            className="mb-5 h-56 w-full rounded-lg sm:h-72"
            testId="img-recipe-hero"
          />
          <h1 className="font-display text-xl font-semibold leading-tight" data-testid="text-recipe-title">
            {recipe.title}
          </h1>
          {recipe.description && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground" data-testid="text-recipe-description">
              {recipe.description}
            </p>
          )}
          <RecipeMeta recipe={recipe} className="mt-3" />

          <div className="no-print mt-5 flex flex-wrap gap-2">
            <Link href={`/cook/${recipe.id}`}>
              <Button data-testid="button-cook">
                <ChefHat className="mr-2 h-4 w-4" /> Cooking mode
              </Button>
            </Link>
            <AddToPlanDialog
              recipeId={recipe.id}
              trigger={
                <Button variant="secondary" data-testid="button-add-to-plan">
                  <CalendarPlus className="mr-2 h-4 w-4" /> Add to plan
                </Button>
              }
            />
            <Button
              variant="outline"
              onClick={() => favorite.mutate()}
              data-testid="button-favorite-detail"
            >
              <Heart className={`mr-2 h-4 w-4 ${recipe.favorite ? "fill-primary text-primary" : ""}`} />
              {recipe.favorite ? "Favorited" : "Favorite"}
            </Button>
            <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
              <Button variant="ghost" data-testid="button-open-source">
                <ExternalLink className="mr-2 h-4 w-4" /> Original
              </Button>
            </a>
          </div>

          <Card className="mt-6 border-card-border p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ingredients</h2>
            <ul className="space-y-2" data-testid="list-ingredients">
              {recipe.ingredients.map((line, index) => (
                <li key={index} className="flex gap-3 text-sm leading-relaxed">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Instructions</h2>
          <ol className="space-y-5" data-testid="list-instructions">
            {recipe.instructions.map((group, groupIndex) => (
              <li key={groupIndex} className="space-y-4">
                {group.heading && <h3 className="font-display text-base font-semibold">{group.heading}</h3>}
                {group.steps.map((step, stepIndex) => (
                  <div key={stepIndex} className="flex gap-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {stepIndex + 1}
                    </span>
                    <div className="space-y-2">
                      <p className="text-sm leading-relaxed">{step.text}</p>
                      {step.image && (
                        <img
                          src={step.image}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="w-full max-w-sm rounded-md"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </li>
            ))}
          </ol>

          {recipe.nutrition && Object.keys(recipe.nutrition).length > 0 && (
            <Card className="mt-6 border-card-border bg-muted/40 p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Nutrition (as published)
              </h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                {Object.entries(recipe.nutrition).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          <div className="mt-6 border-t border-border pt-4">
            <SourceNote recipe={recipe} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
