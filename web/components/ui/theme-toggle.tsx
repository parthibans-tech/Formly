"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

type Theme = "light" | "dark" | "system";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("system");

  React.useEffect(() => {
    const saved = (localStorage.getItem("df_theme") as Theme | null) ?? "system";
    setTheme(saved);
    applyTheme(saved);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      const current = (localStorage.getItem("df_theme") as Theme | null) ?? "system";
      if (current === "system") applyTheme("system");
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const change = (next: Theme) => {
    setTheme(next);
    localStorage.setItem("df_theme", next);
    applyTheme(next);
  };

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => change("light")}>
          <Sun className="h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => change("dark")}>
          <Moon className="h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => change("system")}>
          <Monitor className="h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
