// Roku channel "Tablero de entregas WMS": a SceneGraph app that polls the board feed (JSON) and renders the delivery
// calendar full screen. Roku TVs have no browser, so the board becomes a sideloaded channel (developer mode).
// The zip is built on demand with the board link baked into the manifest (board_url).
import JSZip from 'jszip';
import { ROKU_PNG } from './roku-assets.js';

const MANIFEST = (boardUrl: string) => `title=Tablero de entregas WMS
major_version=1
minor_version=1
build_version=2
mm_icon_focus_hd=pkg:/images/icon_hd.png
mm_icon_focus_sd=pkg:/images/icon_sd.png
splash_screen_hd=pkg:/images/splash_hd.png
splash_screen_sd=pkg:/images/splash_sd.png
splash_color=#0F172A
splash_min_time=500
ui_resolutions=fhd
board_url=${boardUrl}
`;

const MAIN_BRS = `sub Main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)
  scene = screen.CreateScene("BoardScene")
  screen.Show()
  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent"
      if msg.isScreenClosed() then return
    end if
  end while
end sub
`;

const SCENE_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="BoardScene" extends="Scene">
  <script type="text/brightscript" uri="pkg:/components/BoardScene.brs" />
  <children>
    <Rectangle id="bg" width="1920" height="1080" color="0x0F172AFF" />
    <Label id="title" text="ENTREGAS" translation="[60,36]" color="0xFFFFFFFF" />
    <Label id="subtitle" translation="[60,104]" color="0x94A3B8FF" />
    <Label id="clock" translation="[1160,44]" width="700" horizAlign="right" color="0xCBD5E1FF" />
    <Rectangle id="rule" translation="[60,150]" width="1800" height="2" color="0x334155FF" />
    <LayoutGroup id="cols" translation="[60,180]" layoutDirection="horiz" itemSpacings="[40]" />
    <Label id="status" translation="[60,1010]" width="1800" color="0xF87171FF" />
    <Timer id="poll" repeat="true" duration="30" />
    <Timer id="clockTimer" repeat="true" duration="20" />
  </children>
</component>
`;

const SCENE_BRS = `sub init()
  m.cols = m.top.findNode("cols")
  m.status = m.top.findNode("status")
  m.subtitle = m.top.findNode("subtitle")
  m.clock = m.top.findNode("clock")
  m.top.findNode("title").font = "font:LargestBoldSystemFont"
  m.subtitle.font = "font:SmallSystemFont"
  m.clock.font = "font:MediumBoldSystemFont"
  m.status.font = "font:SmallSystemFont"
  m.poll = m.top.findNode("poll")
  m.poll.observeField("fire", "onPoll")
  m.clockTimer = m.top.findNode("clockTimer")
  m.clockTimer.observeField("fire", "onClock")
  info = CreateObject("roAppInfo")
  m.url = info.GetValue("board_url")
  m.subtitle.text = "Cargando... " + m.url
  m.hasData = false
  try
    onClock()
    onPoll()
  catch e
    m.status.text = "Error al iniciar: " + e.message
    print "BoardScene init error: "; e.message
  end try
  m.poll.control = "start"
  m.clockTimer.control = "start"
  m.top.setFocus(true)
end sub

' Sized text uses the default system face (a Font node with no uri); bold titles use the built-in bold font names.
function mkFont(uri as string, size as integer) as object
  f = CreateObject("roSGNode", "Font")
  f.size = size
  return f
end function

function pad2(n as integer) as string
  s = Str(n).Trim()
  if Len(s) < 2 then s = "0" + s
  return s
end function

function dayName(dow as integer) as string
  names = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
  return names[dow]
end function

function monthName(m as integer) as string
  names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
  return names[m - 1]
end function

function localDate(offsetDays as integer) as object
  d = CreateObject("roDateTime")
  d.ToLocalTime()
  d2 = CreateObject("roDateTime")
  d2.FromSeconds(d.AsSeconds() + offsetDays * 86400)
  return d2
end function

function isoOf(d as object) as string
  return Str(d.GetYear()).Trim() + "-" + pad2(d.GetMonth()) + "-" + pad2(d.GetDayOfMonth())
end function

sub onClock()
  d = localDate(0)
  m.clock.text = dayName(d.GetDayOfWeek()) + " " + Str(d.GetDayOfMonth()).Trim() + " " + monthName(d.GetMonth()) + "   " + pad2(d.GetHours()) + ":" + pad2(d.GetMinutes())
end sub

sub onPoll()
  if m.task <> invalid and m.task.state = "run" then return
  m.task = CreateObject("roSGNode", "FetchTask")
  m.task.url = m.url
  m.task.observeField("result", "onResult")
  m.task.control = "run"
end sub

sub onResult()
  try
    res = m.task.result
    if res = invalid
      m.status.text = "Sin conexion con el WMS"
      return
    end if
    if res.ok <> true
      msg = "Sin conexion con el WMS"
      if res.error <> invalid then msg = msg + " (" + res.error + ")"
      if m.hasData then msg = msg + " - mostrando lo ultimo"
      m.status.text = msg
      return
    end if
    m.status.text = ""
    m.hasData = true
    d = localDate(0)
    m.subtitle.text = "Actualizado " + pad2(d.GetHours()) + ":" + pad2(d.GetMinutes())
    render(res.data)
  catch e
    m.status.text = "Error en el tablero: " + e.message
    print "BoardScene onResult error: "; e.message
  end try
end sub

function dateFromIso(iso as string) as object
  d = CreateObject("roDateTime")
  d.FromISO8601String(iso + "T12:00:00")
  return d
end function

sub render(data as object)
  ' clear previous columns
  while m.cols.getChildCount() > 0
    m.cols.removeChildIndex(0)
  end while
  items = data.items
  if items = invalid or items.Count() = 0
    lbl = CreateObject("roSGNode", "Label")
    lbl.text = "Sin entregas programadas"
    lbl.font = "font:LargeSystemFont"
    lbl.color = "0x94A3B8FF"
    m.cols.appendChild(lbl)
    return
  end if
  today = isoOf(localDate(0))
  tomorrow = isoOf(localDate(1))
  ' group by date (items arrive sorted by date, time)
  groups = []
  current = invalid
  for each it in items
    dt = it.delivery_date
    if current = invalid or current.date <> dt
      current = { date: dt, items: [] }
      groups.Push(current)
    end if
    current.items.Push(it)
  end for
  ' three columns, groups filled top to bottom then next column
  colW = 580
  ncols = 3
  perCol = Int((groups.Count() + ncols - 1) / ncols)
  if perCol < 1 then perCol = 1
  gi = 0
  for c = 0 to ncols - 1
    col = CreateObject("roSGNode", "LayoutGroup")
    col.layoutDirection = "vert"
    col.itemSpacings = [22]
    n = 0
    while gi < groups.Count() and n < perCol
      col.appendChild(groupNode(groups[gi], today, tomorrow, colW))
      gi = gi + 1
      n = n + 1
    end while
    m.cols.appendChild(col)
  end for
end sub

function groupNode(g as object, today as string, tomorrow as string, w as integer) as object
  grp = CreateObject("roSGNode", "LayoutGroup")
  grp.layoutDirection = "vert"
  grp.itemSpacings = [8]
  d = dateFromIso(g.date)
  head = CreateObject("roSGNode", "Label")
  tag = ""
  color = "0xFFFFFFFF"
  if g.date = today
    tag = "   HOY"
    color = "0xFBBF24FF"
  else if g.date = tomorrow
    tag = "   MANANA"
    color = "0xFDE68AFF"
  else if g.date < today
    tag = "   ATRASADA"
    color = "0xF87171FF"
  end if
  head.text = dayName(d.GetDayOfWeek()) + " " + Str(d.GetDayOfMonth()).Trim() + " " + monthName(d.GetMonth()) + tag
  head.font = "font:LargeBoldSystemFont"
  head.color = color
  head.width = w
  grp.appendChild(head)
  for each it in g.items
    row = CreateObject("roSGNode", "Label")
    t = it.title
    if it.delivery_time <> invalid and it.delivery_time <> "" then t = t + "  " + it.delivery_time
    if it.status = "DONE" then t = t + "  (entregado)"
    row.text = t
    row.font = "font:LargestBoldSystemFont"
    if it.status = "DONE"
      row.color = "0x64748BFF"
    else
      row.color = "0xFFFFFFFF"
    end if
    row.width = w
    row.wrap = true
    grp.appendChild(row)
    if it.notes <> invalid and it.notes <> ""
      note = CreateObject("roSGNode", "Label")
      note.text = it.notes
      note.font = "font:MediumSystemFont"
      note.color = "0xCBD5E1FF"
      note.width = w
      note.wrap = true
      grp.appendChild(note)
    end if
  end for
  return grp
end function
`;

const TASK_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="FetchTask" extends="Task">
  <interface>
    <field id="url" type="string" />
    <field id="result" type="assocarray" />
  </interface>
  <script type="text/brightscript" uri="pkg:/components/FetchTask.brs" />
</component>
`;

const TASK_BRS = `sub init()
  m.top.functionName = "fetchBoard"
end sub

sub fetchBoard()
  u = CreateObject("roUrlTransfer")
  u.SetCertificatesFile("common:/certs/ca-bundle.crt")
  u.InitClientCertificates()
  u.RetainBodyOnError(true)
  u.SetUrl(m.top.url)
  port = CreateObject("roMessagePort")
  u.SetMessagePort(port)
  if u.AsyncGetToString()
    msg = wait(20000, port)
    if type(msg) = "roUrlEvent"
      if msg.GetResponseCode() = 200
        data = ParseJson(msg.GetString())
        if data <> invalid
          m.top.result = { ok: true, data: data }
        else
          m.top.result = { ok: false, error: "respuesta invalida" }
        end if
      else
        m.top.result = { ok: false, error: "HTTP " + Str(msg.GetResponseCode()).Trim() }
      end if
      return
    end if
    u.AsyncCancel()
  end if
  m.top.result = { ok: false, error: "sin respuesta" }
end sub
`;

/** Builds the sideloadable channel zip for one board link. */
export async function buildRokuZip(boardUrl: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest', MANIFEST(boardUrl));
  zip.file('source/main.brs', MAIN_BRS);
  zip.file('components/BoardScene.xml', SCENE_XML);
  zip.file('components/BoardScene.brs', SCENE_BRS);
  zip.file('components/FetchTask.xml', TASK_XML);
  zip.file('components/FetchTask.brs', TASK_BRS);
  for (const [name, b64] of Object.entries(ROKU_PNG)) zip.file(`images/${name}.png`, Buffer.from(b64, 'base64'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
