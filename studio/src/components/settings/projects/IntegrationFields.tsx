import { isActive, listValue, toggledList, type ProviderControls, type SettingControl } from "../../../lib/projects";
import { Button } from "../../ui";
import { INPUT_CLASS } from "../bits";

interface IntegrationFieldsProps {
  providers: ProviderControls[];
  values: Record<string, string>;
  initial: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
  onToggle: (provider: ProviderControls, on: boolean) => void;
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

// An enum or connection setting as a select; a setting with a default is always set, the others may stay unset.
function SelectControl({ setting, value, disabled, onChange }: ControlProps) {
  const hasDefault = setting.control !== "connection" && setting.defaultText !== "";
  const shown = value || setting.defaultText;
  const stale = shown !== "" && !setting.options.includes(shown);
  return (
    <select aria-label={setting.key} className={INPUT_CLASS} value={shown} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {!hasDefault && <option value="">{setting.control === "connection" ? "none" : "not set"}</option>}
      {stale && <option value={shown}>{`${shown} (not allowed for this org)`}</option>}
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

// The header of a provider box: its state (active, not configured, unavailable) and the Enable or Disable action.
function ProviderHeader({ provider, active, disabled, onToggle }: { provider: ProviderControls; active: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  if (provider.disabled) {
    return (
      <div className="flex items-center justify-between px-3 py-2 text-sm">
        <span className="font-medium">{provider.label}</span>
        <span className="text-dim">nothing to set per project</span>
      </div>
    );
  }
  if (!active && !provider.available) {
    return <div className="px-3 py-2 text-sm text-dim">{`${provider.label} unavailable: the org has no ${provider.label} connection`}</div>;
  }
  return (
    <div className="flex items-center justify-between px-3 py-2 text-sm">
      <span className="font-medium">
        {provider.label}
        <span className="text-dim">{active ? " · active" : " · not configured"}</span>
      </span>
      <Button size="sm" disabled={disabled} className="max-sm:min-h-11" onClick={() => onToggle(!active)}>
        {active ? "Disable" : "Enable"}
      </Button>
    </div>
  );
}

// The Integrations section of the drawer: one box per provider, its settings shown only while it is active.
export function IntegrationFields({ providers, values, initial, disabled, onChange, onToggle }: IntegrationFieldsProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {providers.map((provider) => {
        const active = isActive(provider, values);
        return (
          <div key={provider.kind} className={`rounded-lg border border-line ${provider.disabled ? "opacity-60" : ""}`}>
            <ProviderHeader provider={provider} active={active} disabled={disabled} onToggle={(on) => onToggle(provider, on)} />
            {active &&
              provider.controls.map((setting) => (
                <SettingRow key={setting.key} setting={setting} value={values[setting.key] ?? ""} dirty={(values[setting.key] ?? "") !== (initial[setting.key] ?? "")} disabled={disabled} onChange={(value) => onChange(setting.key, value)} />
              ))}
          </div>
        );
      })}
    </div>
  );
}
