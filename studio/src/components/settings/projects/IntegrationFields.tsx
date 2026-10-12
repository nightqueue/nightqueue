import { listValue, toggledList, type ProviderControls, type SettingControl } from "../../../lib/projects";
import { INPUT_CLASS } from "../bits";

interface IntegrationFieldsProps {
  providers: ProviderControls[];
  values: Record<string, string>;
  initial: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}

interface ControlProps {
  setting: SettingControl;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export const DIRTY_CLASS = "!border-[#f0c674]";

// A boolean setting as a switch; unset shows the declared default.
function SwitchControl({ setting, value, disabled, onChange }: ControlProps) {
  const on = (value || setting.defaultText) === "true";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={setting.key} disabled={disabled} onClick={() => onChange(on ? "false" : "true")} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-button-line transition-colors max-sm:h-7 max-sm:w-12 ${on ? "bg-accent" : "bg-header"}`}>
      <span className={`inline-block size-4 rounded-full bg-fg transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// An enum or connection setting as a select; the empty choice leaves it unset.
function SelectControl({ setting, value, disabled, onChange }: ControlProps) {
  const unset = setting.control === "connection" ? "none" : setting.defaultText ? `default (${setting.defaultText})` : "not set";
  const stale = value !== "" && !setting.options.includes(value);
  return (
    <select aria-label={setting.key} className={INPUT_CLASS} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{unset}</option>
      {stale && <option value={value}>{`${value} (not allowed for this org)`}</option>}
      {setting.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

// A list setting as one checkbox per declared value; unset shows the declared default.
function CheckboxesControl({ setting, value, disabled, onChange }: ControlProps) {
  const checked = listValue(value, setting.defaultText);
  return (
    <div role="group" aria-label={setting.key} className="flex flex-wrap gap-3">
      {setting.options.map((option) => (
        <label key={option} className="inline-flex min-h-8 items-center gap-1.5 text-[13px] max-sm:min-h-11">
          <input type="checkbox" checked={checked.includes(option)} disabled={disabled} onChange={() => onChange(toggledList(checked, option, setting.options))} />
          {option}
        </label>
      ))}
    </div>
  );
}

// A setting of a type this build has no control for, as plain text.
function TextControl({ setting, value, disabled, onChange }: ControlProps) {
  return <input aria-label={setting.key} className={`${INPUT_CLASS} font-mono`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
}

const CONTROLS = { switch: SwitchControl, select: SelectControl, connection: SelectControl, checkboxes: CheckboxesControl, text: TextControl };

// One setting row: its label, its control by type, amber while changed.
function SettingRow({ setting, value, dirty, disabled, onChange }: ControlProps & { dirty: boolean }) {
  const Control = CONTROLS[setting.control];
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${dirty ? DIRTY_CLASS : "border-transparent"}`}>
      <span className="font-mono text-[13px] text-muted">{setting.label}</span>
      <div className="min-w-[160px] max-sm:w-full">
        <Control setting={setting} value={value} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

// The Integrations section of the drawer: one box per provider, its settings rendered by declared type.
export function IntegrationFields({ providers, values, initial, disabled, onChange }: IntegrationFieldsProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {providers.map((provider) => (
        <div key={provider.kind} className={`rounded-lg border border-line ${provider.disabled ? "opacity-60" : ""}`}>
          <div className="flex items-center justify-between px-3 py-2 text-sm">
            <span className="font-medium capitalize">{provider.kind}</span>
            {provider.disabled && <span className="text-dim">nothing to set per project</span>}
          </div>
          {provider.controls.map((setting) => (
            <SettingRow key={setting.key} setting={setting} value={values[setting.key] ?? ""} dirty={(values[setting.key] ?? "") !== (initial[setting.key] ?? "")} disabled={disabled} onChange={(value) => onChange(setting.key, value)} />
          ))}
        </div>
      ))}
    </div>
  );
}
