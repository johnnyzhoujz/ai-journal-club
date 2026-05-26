import { OnboardingPanel } from "@/components/onboarding-panel";

export const dynamic = "force-static";

export default function SetupPage() {
  return (
    <main className="mx-auto max-w-5xl w-full px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold">Setup</h1>
      <OnboardingPanel alwaysOpen />
    </main>
  );
}
