import {
  Menu,
  Images,
  Plus,
  Sticker,
  Users,
  UsersRound,
  Swords,
  CreditCard,
  User,
  BarChart3,
  History,
  Shield,
  LogOut,
  PanelLeftOpen,
} from 'lucide-react';

interface Props {
  open: boolean;
  onToggle: () => void;
  mobile: boolean;
  onNavigate: () => void;
  profileLabel: string;
  isPro: boolean;
  showAdmin: boolean;
  friendRequests: number;
  drawingsClosed: boolean;
  onDrawings: () => void;
  onNew: () => void;
  onTemplates: () => void;
  onFriends: () => void;
  onGroups: () => void;
  onBattles: () => void;
  onPlan: () => void;
  onProfile: () => void;
  onStats: () => void;
  onHistory: () => void;
  onAdmin: () => void;
  onLogout: () => void;
}

function Item({
  Icon,
  label,
  active,
  onClick,
  badge,
}: {
  Icon: typeof Menu;
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button type="button" className={'sc-navbtn' + (active ? ' active' : '')} onClick={onClick} title={label} aria-label={label}>
      <span className="sc-navic">
        <Icon size={17} strokeWidth={2} />
        {badge != null && badge > 0 && <span className="sc-navbadge">{badge > 9 ? '9+' : badge}</span>}
      </span>
      <span className="sc-navlbl">{label}</span>
    </button>
  );
}

function Section({ label }: { label: string }) {
  return <div className="sc-navseclbl">{label}</div>;
}

export default function NavPanel(p: Props) {
  const go = (fn: () => void) => () => {
    fn();
    if (p.mobile) p.onNavigate();
  };

  return (
    <div className={'sc-navrail' + (p.open ? ' open' : '') + (p.mobile && p.open ? ' mobile-open' : '') + (p.mobile && !p.open ? ' mobile-hidden' : '')}>
      <button
        type="button"
        className="sc-navheader"
        onClick={p.onToggle}
        aria-label={p.open ? 'Collapse navigation' : 'Expand navigation'}
        aria-expanded={p.open}
        title={p.open ? 'Collapse navigation' : 'Expand navigation'}
      >
        {p.open ? <PanelLeftOpen size={17} /> : <Menu size={17} />}
      </button>

      <div className="sc-navrail-inner">
        <Section label="Drawing" />
        <Item Icon={Images} label="My Drawings" active={p.drawingsClosed} onClick={p.onDrawings} />
        <Item Icon={Plus} label="New Drawing" onClick={go(p.onNew)} />
        <Item Icon={Sticker} label="Trace Templates" onClick={go(p.onTemplates)} />

        <Section label="Community" />
        <Item Icon={Users} label="Friends" onClick={go(p.onFriends)} badge={p.friendRequests} />
        <Item Icon={UsersRound} label="Groups" onClick={go(p.onGroups)} />
        <Item Icon={Swords} label="Battles" onClick={go(p.onBattles)} />

        <Section label="Account" />
        <Item Icon={CreditCard} label={p.isPro ? 'My Plan · Pro' : 'My Plan'} onClick={go(p.onPlan)} />
        <Item Icon={User} label="Profile" onClick={go(p.onProfile)} />
        <Item Icon={BarChart3} label="Stats" onClick={go(p.onStats)} />
        <Item Icon={History} label="History" onClick={go(p.onHistory)} />
        {p.showAdmin && <Item Icon={Shield} label="Admin Panel" onClick={go(p.onAdmin)} />}

        <div className="sc-navspacer" />
      </div>

      <div className="sc-navfooter">
        <div className="sc-navacct" title={p.profileLabel}>
          <span className="sc-navavatar">{p.profileLabel ? p.profileLabel.charAt(0).toUpperCase() : '•'}</span>
          {p.open && (
            <span className="sc-navacctname">
              <span className="sc-navacctmain">{p.profileLabel}</span>
              {p.isPro && <span className="sc-navpro">Pro</span>}
            </span>
          )}
        </div>
        <Item Icon={LogOut} label="Log Out" onClick={go(p.onLogout)} />
      </div>
    </div>
  );
}