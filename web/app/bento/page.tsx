import { Suspense } from "react";
import { Web3Bento } from "@/components/ui/web3-bento";

// Step B test page: the Web3 Bento component, unchanged, with its own demo data.
// Everything shown here is the component's built-in sample data, NOT Kairo data.
// The component reads the current date, so it is wrapped in Suspense (Next.js then
// draws it when someone opens the page instead of freezing the date at build time).
export default function BentoTestPage() {
  return (
    <div className="dark flex min-h-screen w-full items-start justify-center bg-background p-4 sm:p-8">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Web3Bento />
      </Suspense>
    </div>
  );
}
