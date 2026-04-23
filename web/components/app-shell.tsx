"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Menu,
  Search,
  Settings,
  X,
} from "lucide-react";
import { clearSession, getToken, getUser } from "@/lib/api";
import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useConfirm } from "@/components/ui/confirm";

type Props = {
  children: React.ReactNode;
  /**
   * Optional header search box wiring. Not every view needs global search
   * (settings pages don't), so we let the caller opt in with a controlled
   * value + handler.
   */
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  };
  /** Extra actions rendered on the right side of the top bar, before the avatar. */
  headerRight?: React.ReactNode;
};

export function AppShell({ children, search, headerRight }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [user, setUser] = useState<any>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setUser(getUser());
  }, [router]);

  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  async function logout() {
    const ok = await confirm({
      title: "Sign out?",
      description: "You'll need to sign in again to continue.",
      confirmLabel: "Sign out",
    });
    if (!ok) return;
    clearSession();
    router.replace("/login");
  }

  if (!user) return null;

  const initials = (user.email || "U")
    .split("@")[0]
    .split(/[.\-_ ]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p: string) => p[0]?.toUpperCase())
    .join("");

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r bg-card/40 md:flex md:flex-col">
        <AppSidebar />
      </aside>

      {/* Mobile sidebar drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-background shadow-xl">
            <div className="flex items-center justify-between border-b p-3">
              <span className="text-sm font-semibold">Menu</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <AppSidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="md:pl-60">
        <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-14 items-center gap-3 px-4 md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>

            {search ? (
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search.value}
                  onChange={(e) => search.onChange(e.target.value)}
                  placeholder={search.placeholder ?? "Search…"}
                  className="pl-9"
                  aria-label="Search"
                />
              </div>
            ) : (
              <span className="hidden md:block text-sm text-muted-foreground">
                &nbsp;
              </span>
            )}

            <div className="ml-auto flex items-center gap-1">
              {headerRight}
              <ThemeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Account menu"
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>{initials || "U"}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {user.name || "Account"}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {user.email}
                      </span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/settings/account">
                      <Settings className="h-4 w-4" />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout} destructive>
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <Separator />
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
