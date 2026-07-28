/**
 * Offline fallback catalog.
 *
 * Used ONLY when the live Eating on a Dime site cannot be reached (no network
 * in a preview sandbox, site down, rate limited). Everything here is clearly
 * labelled as demo content in the UI and is generic home cooking, not a copy
 * of any publisher's text.
 */
import type { InstructionGroup } from "@shared/schema";

export type DemoRecipe = {
  slug: string;
  title: string;
  description: string;
  author: string;
  prepMinutes: number;
  cookMinutes: number;
  totalMinutes: number;
  servings: string;
  categories: string[];
  cuisines: string[];
  ingredients: string[];
  instructions: InstructionGroup[];
  nutrition: Record<string, string>;
};

const steps = (list: string[]): InstructionGroup[] => [{ steps: list.map((text) => ({ text })) }];

export const DEMO_RECIPES: DemoRecipe[] = [
  {
    slug: "crockpot-chicken-and-noodles",
    title: "Crockpot Chicken and Noodles",
    description:
      "A comforting slow cooker dinner: tender shredded chicken and wide egg noodles in a creamy, savory sauce.",
    author: "Demo Kitchen",
    prepMinutes: 15,
    cookMinutes: 360,
    totalMinutes: 375,
    servings: "6 servings",
    categories: ["Main Course"],
    cuisines: ["American"],
    ingredients: [
      "2 pounds boneless skinless chicken breasts",
      "2 cans (10.5 ounce each) cream of chicken soup",
      "1 can (14.5 ounce) low-sodium chicken broth",
      "1/2 cup butter (cut into cubes)",
      "1 medium onion (diced)",
      "1 teaspoon dried thyme",
      "1 teaspoon garlic powder",
      "1/2 teaspoon salt",
      "1/4 teaspoon black pepper",
      "12 ounces wide egg noodles",
      "Chopped fresh parsley (for garnish, optional)",
    ],
    instructions: steps([
      "Place the chicken breasts in the bottom of the slow cooker.",
      "Add the soup, broth, butter, onion, thyme, garlic powder, salt and pepper on top of the chicken.",
      "Cover and cook on low for 6 to 7 hours, until the chicken shreds easily.",
      "Shred the chicken with two forks and stir it back into the sauce.",
      "Stir in the egg noodles, cover, and cook on high for 20 to 30 minutes until tender.",
      "Garnish with parsley and serve warm.",
    ]),
    nutrition: { Calories: "512 kcal", Protein: "38 g", Carbs: "41 g", Fat: "21 g" },
  },
  {
    slug: "sheet-pan-sausage-and-peppers",
    title: "Sheet Pan Sausage and Peppers",
    description: "One pan, twenty-five minutes: smoked sausage roasted with sweet peppers, onion and potatoes.",
    author: "Demo Kitchen",
    prepMinutes: 10,
    cookMinutes: 25,
    totalMinutes: 35,
    servings: "4 servings",
    categories: ["Main Course"],
    cuisines: ["American"],
    ingredients: [
      "1 pound smoked sausage (sliced)",
      "3 bell peppers (sliced)",
      "1 large onion (sliced)",
      "1 pound baby potatoes (halved)",
      "3 tablespoons olive oil",
      "1 teaspoon Italian seasoning",
      "1/2 teaspoon garlic powder",
      "1/2 teaspoon salt",
      "1/4 teaspoon black pepper",
    ],
    instructions: steps([
      "Heat the oven to 425°F and line a large sheet pan with parchment.",
      "Toss the potatoes with 1 tablespoon olive oil and roast for 10 minutes.",
      "Toss the sausage, peppers and onion with the remaining oil and seasonings.",
      "Add them to the pan and roast 15 to 18 minutes more, stirring once.",
      "Serve hot straight from the pan.",
    ]),
    nutrition: { Calories: "486 kcal", Protein: "19 g", Carbs: "32 g", Fat: "31 g" },
  },
  {
    slug: "easy-beef-tacos",
    title: "Easy Weeknight Beef Tacos",
    description: "Seasoned ground beef tacos with all the toppings — on the table in twenty minutes.",
    author: "Demo Kitchen",
    prepMinutes: 5,
    cookMinutes: 15,
    totalMinutes: 20,
    servings: "5 servings",
    categories: ["Main Course"],
    cuisines: ["Mexican"],
    ingredients: [
      "1 pound ground beef",
      "1 tablespoon taco seasoning",
      "1/2 cup water",
      "10 corn tortillas",
      "1 cup shredded cheddar cheese",
      "2 cups shredded lettuce",
      "2 medium tomatoes (diced)",
      "1/2 cup sour cream",
      "1 lime (cut into wedges)",
    ],
    instructions: steps([
      "Brown the ground beef in a skillet over medium-high heat and drain the fat.",
      "Stir in the taco seasoning and water, then simmer 5 minutes until thickened.",
      "Warm the tortillas in a dry skillet.",
      "Fill each tortilla with beef and top with cheese, lettuce, tomato and sour cream.",
      "Finish with a squeeze of lime.",
    ]),
    nutrition: { Calories: "398 kcal", Protein: "24 g", Carbs: "28 g", Fat: "21 g" },
  },
  {
    slug: "creamy-tomato-basil-soup",
    title: "Creamy Tomato Basil Soup",
    description: "A pantry-friendly tomato soup finished with cream and fresh basil. Perfect with grilled cheese.",
    author: "Demo Kitchen",
    prepMinutes: 10,
    cookMinutes: 25,
    totalMinutes: 35,
    servings: "4 servings",
    categories: ["Soup"],
    cuisines: ["American"],
    ingredients: [
      "2 tablespoons butter",
      "1 medium onion (diced)",
      "3 cloves garlic (minced)",
      "2 cans (28 ounce each) crushed tomatoes",
      "2 cups low-sodium chicken broth",
      "1 teaspoon sugar",
      "1/2 teaspoon salt",
      "1/4 teaspoon black pepper",
      "1/2 cup heavy cream",
      "1/4 cup chopped fresh basil",
    ],
    instructions: steps([
      "Melt the butter in a Dutch oven and cook the onion until soft, about 5 minutes.",
      "Add the garlic and cook 1 minute more.",
      "Stir in the tomatoes, broth, sugar, salt and pepper and simmer 20 minutes.",
      "Blend until smooth with an immersion blender.",
      "Stir in the cream and basil just before serving.",
    ]),
    nutrition: { Calories: "268 kcal", Protein: "6 g", Carbs: "26 g", Fat: "16 g" },
  },
  {
    slug: "honey-garlic-chicken-thighs",
    title: "Honey Garlic Chicken Thighs",
    description: "Crisp-skinned chicken thighs glazed in a sticky honey garlic sauce, baked in one dish.",
    author: "Demo Kitchen",
    prepMinutes: 10,
    cookMinutes: 35,
    totalMinutes: 45,
    servings: "4 servings",
    categories: ["Main Course"],
    cuisines: ["Asian"],
    ingredients: [
      "8 bone-in chicken thighs",
      "1/3 cup honey",
      "1/4 cup soy sauce",
      "4 cloves garlic (minced)",
      "1 tablespoon rice vinegar",
      "1 teaspoon grated ginger",
      "1/2 teaspoon black pepper",
      "2 green onions (sliced)",
      "1 teaspoon sesame seeds",
    ],
    instructions: steps([
      "Heat the oven to 400°F.",
      "Whisk the honey, soy sauce, garlic, vinegar, ginger and pepper together.",
      "Arrange the thighs skin side up in a baking dish and pour the sauce over.",
      "Bake 35 minutes, basting once, until the internal temperature reaches 175°F.",
      "Scatter with green onion and sesame seeds before serving.",
    ]),
    nutrition: { Calories: "441 kcal", Protein: "32 g", Carbs: "24 g", Fat: "24 g" },
  },
  {
    slug: "loaded-baked-potato-casserole",
    title: "Loaded Baked Potato Casserole",
    description: "Everything you love about a loaded potato, baked into a bubbling family-size casserole.",
    author: "Demo Kitchen",
    prepMinutes: 20,
    cookMinutes: 40,
    totalMinutes: 60,
    servings: "8 servings",
    categories: ["Side Dish"],
    cuisines: ["American"],
    ingredients: [
      "3 pounds russet potatoes (cubed)",
      "8 slices bacon (cooked and crumbled)",
      "1 cup sour cream",
      "2 cups shredded cheddar cheese",
      "1/2 cup butter",
      "1/2 teaspoon salt",
      "1/4 teaspoon black pepper",
      "3 green onions (sliced)",
    ],
    instructions: steps([
      "Heat the oven to 375°F and butter a 9x13 baking dish.",
      "Boil the potatoes until fork tender, about 15 minutes, then drain.",
      "Mash with the butter, sour cream, salt and pepper.",
      "Fold in half the cheese and half the bacon, then spread into the dish.",
      "Top with the remaining cheese and bake 25 minutes until bubbling.",
      "Finish with the remaining bacon and green onion.",
    ]),
    nutrition: { Calories: "512 kcal", Protein: "16 g", Carbs: "38 g", Fat: "33 g" },
  },
  {
    slug: "chicken-broccoli-alfredo-bake",
    title: "Chicken Broccoli Alfredo Bake",
    description: "Penne, chicken and broccoli folded into a quick alfredo and baked until golden.",
    author: "Demo Kitchen",
    prepMinutes: 15,
    cookMinutes: 30,
    totalMinutes: 45,
    servings: "6 servings",
    categories: ["Main Course"],
    cuisines: ["Italian"],
    ingredients: [
      "12 ounces penne pasta",
      "2 cups cooked shredded chicken",
      "4 cups broccoli florets",
      "3 tablespoons butter",
      "3 cloves garlic (minced)",
      "2 cups heavy cream",
      "1 1/2 cups grated parmesan cheese",
      "1/2 teaspoon salt",
      "1/4 teaspoon black pepper",
      "1 cup shredded mozzarella cheese",
    ],
    instructions: steps([
      "Heat the oven to 375°F and cook the pasta one minute short of al dente.",
      "Add the broccoli to the pasta water for the final two minutes, then drain.",
      "Melt the butter, cook the garlic 30 seconds, then whisk in the cream and simmer.",
      "Stir in the parmesan, salt and pepper until smooth.",
      "Fold in the pasta, broccoli and chicken, transfer to a baking dish and top with mozzarella.",
      "Bake 20 minutes until golden and bubbling.",
    ]),
    nutrition: { Calories: "684 kcal", Protein: "38 g", Carbs: "48 g", Fat: "38 g" },
  },
  {
    slug: "slow-cooker-beef-chili",
    title: "Slow Cooker Beef Chili",
    description: "A thick, smoky chili that simmers all day and feeds a crowd for a few dollars.",
    author: "Demo Kitchen",
    prepMinutes: 15,
    cookMinutes: 300,
    totalMinutes: 315,
    servings: "8 servings",
    categories: ["Main Course"],
    cuisines: ["American"],
    ingredients: [
      "2 pounds ground beef",
      "1 large onion (diced)",
      "3 cloves garlic (minced)",
      "2 cans (15 ounce each) kidney beans (drained)",
      "1 can (28 ounce) crushed tomatoes",
      "1 can (6 ounce) tomato paste",
      "2 tablespoons chili powder",
      "1 tablespoon cumin",
      "1 teaspoon smoked paprika",
      "1 teaspoon salt",
      "1 cup shredded cheddar cheese",
    ],
    instructions: steps([
      "Brown the beef with the onion in a skillet, then drain and add to the slow cooker.",
      "Stir in the garlic, beans, tomatoes, tomato paste and spices.",
      "Cover and cook on low for 5 hours.",
      "Taste and adjust the salt, then serve topped with cheddar.",
    ]),
    nutrition: { Calories: "452 kcal", Protein: "33 g", Carbs: "31 g", Fat: "22 g" },
  },
];

export function demoBySlug(slug: string): DemoRecipe | undefined {
  return DEMO_RECIPES.find((r) => r.slug === slug);
}

export function demoSearch(query: string): DemoRecipe[] {
  const q = query.trim().toLowerCase();
  if (!q) return DEMO_RECIPES;
  return DEMO_RECIPES.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.ingredients.some((i) => i.toLowerCase().includes(q)),
  );
}
