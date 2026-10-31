import { useId, type HTMLAttributes, type ReactNode } from "react";

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: string;
  help?: string;
  children?: ReactNode | ((props: { id: string }) => ReactNode);
}

export default function Field({ label, help, children, className, ...props }: FieldProps) {
  const id = useId();
  return (
    <div {...props} className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>{label}</label>
      {typeof children === "function" ? children({ id }) : children}
      {help && <small>{help}</small>}
    </div>
  );
}
