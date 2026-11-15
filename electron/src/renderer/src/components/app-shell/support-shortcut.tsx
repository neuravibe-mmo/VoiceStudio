import { useTranslation } from 'react-i18next';
import { LanguagesIcon } from 'lucide-react';
import i18n, { APP_LANGUAGES, setAppLanguage, type AppLocale } from '@/i18n';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const HEADER_LANGUAGES = [
  ...APP_LANGUAGES.filter(({ code }) => code === 'vi' || code === 'en'),
  ...APP_LANGUAGES.filter(({ code }) => code !== 'vi' && code !== 'en'),
];
const HEADER_LANGUAGE_ITEMS = HEADER_LANGUAGES.map(({ code, label }) => ({
  value: code,
  label,
}));

export function SupportShortcut() {
  const { t } = useTranslation();
  const currentLanguage = (i18n.resolvedLanguage || i18n.language || 'en') as AppLocale;

  return (
    <div className="flex shrink-0 items-center">
      <Select
        items={HEADER_LANGUAGE_ITEMS}
        value={currentLanguage}
        onValueChange={(value) => void setAppLanguage(value as AppLocale)}
      >
        <SelectTrigger
          size="sm"
          className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs font-normal text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-1"
          aria-label={t('settings.language')}
        >
          <LanguagesIcon className="size-3.5 shrink-0" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false} className="max-h-72 min-w-36">
          {HEADER_LANGUAGES.map(({ code, label }) => (
            <SelectItem key={code} value={code} className="text-xs">
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
