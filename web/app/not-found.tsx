import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";

export default function NotFound(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Not found" subtitle="There is no page at this address." />
      <EmptyState title="Nothing here" reason="404">
        <Link href="/" className="text-accent hover:underline">
          Back to the home page
        </Link>
      </EmptyState>
    </>
  );
}
