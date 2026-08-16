import { cn } from "@workspace/ui/lib/utils";

export function SelenaWordmark({ className }: { className?: string }) {
	return (
		<span className={cn("inline-flex items-baseline gap-2 leading-none", className)}>
			<span className="selena-wordmark-name">Selena</span>
			<span className="selena-wordmark-systems">Systems</span>
			<span className="size-1.5 rounded-full bg-[#b9825b]" aria-hidden="true" />
		</span>
	);
}
