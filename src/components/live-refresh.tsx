"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => router.refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return null;
}
