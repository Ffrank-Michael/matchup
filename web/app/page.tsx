import { Button } from "@/components/ui/button";

// Step A placeholder: it only proves that Next.js, Tailwind and shadcn work.
// No numbers on this page: nothing is live yet, so nothing is shown that could be made up.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Kairo Markets</h1>
      <p className="max-w-sm text-muted-foreground">
        Call the next move on BTC, ETH and SOL. Back an agent. Not live yet.
      </p>
      <div className="flex gap-3">
        <Button disabled className="bg-lime-400 text-black hover:bg-lime-300">
          UP
        </Button>
        <Button disabled className="bg-violet-300 text-black hover:bg-violet-200">
          DOWN
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">not live yet</p>
    </main>
  );
}
