/**
 * The three ways a recipe leaves Dime Dinner for ReciMe.
 *
 * ReciMe imports pasted text, and it imports PDFs, so those are the two
 * payloads offered. Sharing is a third route rather than a fourth format: it
 * hands the same PDF to the native share sheet, which on iOS is the only way
 * to get a file into another app without going via Files.
 *
 * Only one recipe goes out at a time. A menu that could bundle several would
 * produce a PDF that ReciMe reads as one long garbled recipe.
 */
import { useState } from "react";
import { Copy, Download, FileDown, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { copyText } from "@/lib/app";
import {
  downloadRecimePdf,
  probeFile,
  shareCapability,
  shareToRecime,
  type ShareCapability,
} from "@/lib/recimeShare";
import { formatRecipeForRecime, RECIME_DISCLAIMER } from "@shared/recime";
import type { RecipeDTO } from "@shared/schema";

/**
 * Measured once per mount. `navigator.canShare` does not change while the page
 * is open, and probing on every render would build a throwaway File each time.
 */
function useShareCapability(): ShareCapability {
  const [capability] = useState<ShareCapability>(() =>
    shareCapability(typeof navigator === "undefined" ? undefined : navigator, probeFile()),
  );
  return capability;
}

export function RecimeExportMenu({ recipe }: { recipe: RecipeDTO }) {
  const { toast } = useToast();
  const capability = useShareCapability();
  const [sharing, setSharing] = useState(false);

  const copy = async () => {
    const copied = await copyText(formatRecipeForRecime(recipe));
    toast(
      copied
        ? {
            title: "Copied for ReciMe",
            description: "In ReciMe, choose Add recipe → Paste text, then paste. Check it before saving.",
          }
        : {
            title: "Could not copy",
            description: "This browser blocked the clipboard. Export the PDF instead.",
            variant: "destructive",
          },
    );
  };

  const download = () => {
    downloadRecimePdf(recipe.id);
    toast({
      title: "Exporting a PDF",
      description: "One recipe, one file. Open it in ReciMe with Add recipe → Import file.",
    });
  };

  const share = async () => {
    setSharing(true);
    try {
      const outcome = await shareToRecime(recipe);
      if (outcome.kind === "shared") {
        toast({
          title: "Handed to the share sheet",
          description: outcome.withFile
            ? "Pick ReciMe to import the PDF."
            : "Your device could not share the file, so the recipe text went instead. Paste it into ReciMe.",
        });
      } else if (outcome.kind === "fellBack") {
        toast({
          title: "Sharing is not available here",
          description: outcome.copied
            ? "The recipe text was copied and the PDF is downloading. In ReciMe, paste the text or import the file."
            : "The PDF is downloading. In ReciMe, choose Add recipe → Import file.",
        });
      } else if (outcome.kind === "failed") {
        toast({ title: "Share failed", description: outcome.message, variant: "destructive" });
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={sharing} data-testid="button-recime-export">
          {sharing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
          Send to ReciMe
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Send this recipe to ReciMe</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copy()} data-testid="menu-recime-copy">
          <Copy className="mr-2 h-4 w-4" /> Copy for ReciMe
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download()} data-testid="menu-recime-pdf">
          <Download className="mr-2 h-4 w-4" /> Export PDF for ReciMe
        </DropdownMenuItem>
        {capability !== "none" && (
          <DropdownMenuItem onSelect={() => void share()} data-testid="menu-recime-share">
            <Share2 className="mr-2 h-4 w-4" /> Share to ReciMe
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="text-recime-disclaimer">
          {RECIME_DISCLAIMER}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
