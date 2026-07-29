/**
 * Handing one recipe to ReciMe from the browser.
 *
 * There are three ways out, and which of them exists depends entirely on where
 * the app is being viewed. On an iPhone in the Home Assistant app the native
 * share sheet can pass a PDF straight to ReciMe, which is the whole point of
 * the feature. In a desktop browser there is usually no share sheet at all,
 * and inside some Home Assistant WebViews `navigator.share` exists but refuses
 * files. So the capability is measured rather than assumed, and every path
 * degrades to something that still works: copy the text, download the PDF.
 *
 * The decision functions take their inputs as arguments instead of reading
 * globals, so what the UI will do in each environment can be tested directly.
 */
import { formatRecipeForRecime, recimeFilename, type RecimeExportRecipe } from "@shared/recime";
import { copyText } from "./app";
import { API_BASE } from "./queryClient";

export type ShareCapability = "files" | "text" | "none";

type ShareLike = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

/**
 * What this browser can actually do.
 *
 * `canShare({ files })` is the only honest test for file sharing — Android
 * Chrome and iOS Safari both expose `navigator.share` while accepting a
 * different set of payloads, and a `share()` call with an unsupported payload
 * rejects after the user has already tapped the button.
 */
export function shareCapability(nav: ShareLike | undefined, sample?: File): ShareCapability {
  if (!nav?.share) return "none";
  if (sample && nav.canShare?.({ files: [sample] })) return "files";
  return "text";
}

/** A one-byte stand-in, so capability can be probed without building the real PDF. */
export function probeFile(): File | undefined {
  if (typeof File === "undefined") return undefined;
  try {
    return new File([new Uint8Array([0x25])], "probe.pdf", { type: "application/pdf" });
  } catch {
    return undefined;
  }
}

export function recimePdfUrl(recipeId: number): string {
  return `${API_BASE}/api/recipes/${recipeId}/recime.pdf`;
}

export async function fetchRecimePdf(recipeId: number, title: string): Promise<File> {
  const response = await fetch(recimePdfUrl(recipeId));
  if (!response.ok) throw new Error(`The PDF could not be generated (HTTP ${response.status}).`);
  const blob = await response.blob();
  return new File([blob], recimeFilename(title), { type: "application/pdf" });
}

/** Save the PDF to the device. The browser decides where. */
export function downloadRecimePdf(recipeId: number): void {
  const anchor = document.createElement("a");
  anchor.href = recimePdfUrl(recipeId);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export type ShareOutcome =
  | { kind: "shared"; withFile: boolean }
  | { kind: "cancelled" }
  /** Sharing was not possible, so the text was copied and the PDF downloaded. */
  | { kind: "fellBack"; copied: boolean }
  | { kind: "failed"; message: string };

/**
 * Share the recipe, falling back rather than failing.
 *
 * A user who dismisses the share sheet has not hit an error and must not be
 * shown one, so an AbortError comes back as "cancelled" and nothing else
 * happens. Anything else that goes wrong drops to copy-and-download, because
 * the user asked to get this recipe into ReciMe and there is still a way.
 */
export async function shareToRecime(
  recipe: RecimeExportRecipe & { id: number },
  nav: ShareLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Promise<ShareOutcome> {
  const text = formatRecipeForRecime(recipe);
  const capability = shareCapability(nav, probeFile());

  if (capability === "files") {
    try {
      const file = await fetchRecimePdf(recipe.id, recipe.title);
      if (nav?.canShare?.({ files: [file] })) {
        await nav.share!({ files: [file], title: recipe.title, text });
        return { kind: "shared", withFile: true };
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return { kind: "cancelled" };
      // Fall through: a share sheet that promised files and then refused one
      // is still better served by the text path than by an error.
    }
  }

  if (capability !== "none") {
    try {
      await nav!.share!({ title: recipe.title, text });
      return { kind: "shared", withFile: false };
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return { kind: "cancelled" };
    }
  }

  const copied = await copyText(text);
  downloadRecimePdf(recipe.id);
  return { kind: "fellBack", copied };
}
