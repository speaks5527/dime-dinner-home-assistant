import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { DAYS, dayDate, formatWeekRange, postJson, shiftWeek, weekStartOf } from "@/lib/app";

export function AddToPlanDialog({ recipeId, trigger }: { recipeId: number; trigger: ReactNode }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [weekStart, setWeekStart] = useState(weekStartOf());
  const [day, setDay] = useState("0");
  const [meal, setMeal] = useState("dinner");

  const add = useMutation({
    mutationFn: () => postJson(`/api/plan/${weekStart}`, { day: Number(day), meal, recipeId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plan"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grocery"] });
      setOpen(false);
      toast({ title: `Added to ${DAYS[Number(day)]} ${meal}` });
    },
  });

  const thisWeek = weekStartOf();
  const weeks = [0, 1, 2, 3].map((offset) => shiftWeek(thisWeek, offset));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="dialog-add-to-plan">
        <DialogHeader>
          <DialogTitle className="font-display">Add to the weekly plan</DialogTitle>
          <DialogDescription>Pick a week, day and meal slot. Existing meals in that slot are replaced.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select value={weekStart} onValueChange={setWeekStart}>
            <SelectTrigger data-testid="select-week">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weeks.map((week, index) => (
                <SelectItem key={week} value={week}>
                  {index === 0 ? "This week" : index === 1 ? "Next week" : formatWeekRange(week)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={day} onValueChange={setDay}>
            <SelectTrigger data-testid="select-day">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS.map((name, index) => (
                <SelectItem key={name} value={String(index)}>
                  {name} {dayDate(weekStart, index).getDate()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={meal} onValueChange={setMeal}>
            <SelectTrigger data-testid="select-meal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lunch">Lunch</SelectItem>
              <SelectItem value="dinner">Dinner</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => add.mutate()} disabled={add.isPending} data-testid="button-confirm-add-to-plan">
          Add to plan
        </Button>
      </DialogContent>
    </Dialog>
  );
}
