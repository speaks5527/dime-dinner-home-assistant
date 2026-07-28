import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import RecipesPage from "@/pages/recipes";
import RecipeDetailPage from "@/pages/recipe-detail";
import CookPage from "@/pages/cook";
import PlannerPage from "@/pages/planner";
import GroceryPage from "@/pages/grocery";
import PantryPage from "@/pages/pantry";
import SettingsPage from "@/pages/settings";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={RecipesPage} />
      <Route path="/recipes/:id" component={RecipeDetailPage} />
      <Route path="/cook/:id" component={CookPage} />
      <Route path="/planner" component={PlannerPage} />
      <Route path="/grocery" component={GroceryPage} />
      <Route path="/pantry" component={PantryPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
