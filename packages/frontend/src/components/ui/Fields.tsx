import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import "./TextField.css"; // `.ui-text-field`: opt-in look of a one-line box that fills its row (skills)

// The app's form fields. Each is the native element with every prop and the ref passed
// through, so keyboard, focus and `name`/`form` behave natively. They add no class: the phone
// 16px floor (no iOS zoom on focus) and the focus ring come from styles/input-font.css and
// global.css selectors on the element itself, so a field looks the same wherever it is used.
// One component per kind of control, so the kind is visible at the call site:
//   TextField  one-line text, search, number, time, date, email, password
//   Checkbox / Radio / RangeInput / ColorInput / FileInput
//   Select     native list      TextArea  multi-line text

type TextFieldType = "text" | "search" | "number" | "time" | "date" | "email" | "password" | "url" | "tel";
type Without<T extends InputHTMLAttributes<HTMLInputElement>> = Omit<T, "type">;

export const TextField = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>> & { type?: TextFieldType }>(
  function TextField(props, ref) { return <input ref={ref} {...props} />; });

export const Checkbox = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>>>(
  function Checkbox(props, ref) { return <input ref={ref} {...props} type="checkbox" />; });

export const Radio = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>>>(
  function Radio(props, ref) { return <input ref={ref} {...props} type="radio" />; });

export const RangeInput = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>>>(
  function RangeInput(props, ref) { return <input ref={ref} {...props} type="range" />; });

export const ColorInput = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>>>(
  function ColorInput(props, ref) { return <input ref={ref} {...props} type="color" />; });

export const FileInput = forwardRef<HTMLInputElement, Without<InputHTMLAttributes<HTMLInputElement>>>(
  function FileInput(props, ref) { return <input ref={ref} {...props} type="file" />; });

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) { return <select ref={ref} {...props} />; });

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea(props, ref) { return <textarea ref={ref} {...props} />; });
