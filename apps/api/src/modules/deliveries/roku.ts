// Roku channel "Tablero de entregas WMS": a SceneGraph app that polls the board feed (JSON) and renders the delivery
// calendar full screen. Roku TVs have no browser, so the board becomes a sideloaded channel (developer mode).
// The zip is built on demand with the board link baked into the manifest (board_url).
import JSZip from 'jszip';
import { ROKU_PNG } from './roku-assets.js';

const MANIFEST = (boardUrl: string) => `title=Tablero de entregas WMS
major_version=1
minor_version=2
build_version=3
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
    <Group id="grid" translation="[40,170]" />
    <Label id="overdue" translation="[40,1010]" width="1840" color="0xF87171FF" />
    <Label id="status" translation="[1160,1010]" width="720" horizAlign="right" color="0xF87171FF" />
    <Timer id="poll" repeat="true" duration="30" />
    <Timer id="clockTimer" repeat="true" duration="20" />
  </children>
</component>
`;

const SCENE_BRS = `sub init()
  m.grid = m.top.findNode("grid")
  m.overdue = m.top.findNode("overdue")
  m.overdue.font = "font:SmallBoldSystemFont"
  m.status = m.top.findNode("status")
  m.subtitle = m.top.findNode("subtitle")
  m.clock = m.top.findNode("clock")
  m.top.findNode("title").font = "font:LargeBoldSystemFont"
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
  while m.grid.getChildCount() > 0
    m.grid.removeChildIndex(0)
  end while
  items = data.items
  if items = invalid then items = []
  today = isoOf(localDate(0))
  d0 = localDate(0)
  offset = (d0.GetDayOfWeek() + 6) mod 7   ' days since Monday
  mondayIso = isoOf(localDate(-offset))
  ' the calendar: this week and next, Monday..Saturday (Sunday deliveries show in Saturday's box)
  ncols = 6
  gap = 8
  colW = Int((1840 - gap * (ncols - 1)) / ncols)
  rowH = 400
  overdueTxt = ""
  for each it in items
    if it.status = "PLANNED" and it.delivery_date < mondayIso
      if overdueTxt <> "" then overdueTxt = overdueTxt + "  ·  "
      overdueTxt = overdueTxt + it.title + " (" + Mid(it.delivery_date, 9, 2) + "/" + Mid(it.delivery_date, 6, 2) + ")"
    end if
  end for
  if overdueTxt <> "" then m.overdue.text = "ATRASADAS: " + overdueTxt else m.overdue.text = ""
  for w = 0 to 1
    for c = 0 to ncols - 1
      dayOff = -offset + w * 7 + c
      d = localDate(dayOff)
      iso = isoOf(d)
      sundayIso = ""
      if c = ncols - 1 then sundayIso = isoOf(localDate(dayOff + 1))
      x = c * (colW + gap)
      y = w * (rowH + gap)
      isToday = (iso = today)
      cellItems = []
      for each it in items
        if it.delivery_date = iso then cellItems.Push(it)
      end for
      if sundayIso <> ""
        for each it in items
          if it.delivery_date = sundayIso then cellItems.Push({ title: "dom · " + it.title, delivery_time: it.delivery_time, notes: it.notes, status: it.status })
        end for
      end if
      m.grid.appendChild(cellNode(x, y, colW, rowH, d, isToday, iso < today, cellItems))
    end for
  end for
end sub

function cellNode(x as integer, y as integer, w as integer, h as integer, d as object, isToday as boolean, isPast as boolean, cellItems as object) as object
  g = CreateObject("roSGNode", "Group")
  g.translation = [x, y]
  bg = CreateObject("roSGNode", "Rectangle")
  bg.width = w
  bg.height = h
  if isToday
    bg.color = "0x3B2F0BFF"
  else if isPast
    bg.color = "0x0F172AFF"
  else
    bg.color = "0x1E293BFF"
  end if
  g.appendChild(bg)
  if isToday
    border = CreateObject("roSGNode", "Rectangle")
    border.width = w
    border.height = 6
    border.color = "0xFBBF24FF"
    g.appendChild(border)
  end if
  head = CreateObject("roSGNode", "Label")
  head.translation = [12, 10]
  head.width = w - 24
  head.font = "font:MediumBoldSystemFont"
  if isToday
    head.color = "0xFBBF24FF"
    head.text = dayName(d.GetDayOfWeek()) + " " + Str(d.GetDayOfMonth()).Trim() + " " + monthName(d.GetMonth()) + "  · HOY"
  else
    if isPast then head.color = "0x64748BFF" else head.color = "0xE2E8F0FF"
    head.text = dayName(d.GetDayOfWeek()) + " " + Str(d.GetDayOfMonth()).Trim() + " " + monthName(d.GetMonth())
  end if
  g.appendChild(head)
  list = CreateObject("roSGNode", "LayoutGroup")
  list.translation = [12, 58]
  list.layoutDirection = "vert"
  list.itemSpacings = [10]
  n = 0
  for each it in cellItems
    n = n + 1
    if n > 5
      more = CreateObject("roSGNode", "Label")
      more.text = "+" + Str(cellItems.Count() - 5).Trim() + " mas"
      more.font = "font:SmallSystemFont"
      more.color = "0x94A3B8FF"
      list.appendChild(more)
      exit for
    end if
    row = CreateObject("roSGNode", "Label")
    t = it.title
    if it.delivery_time <> invalid and it.delivery_time <> "" then t = it.delivery_time + "  " + t
    row.text = t
    row.font = "font:MediumBoldSystemFont"
    if it.status = "DONE" then row.color = "0x64748BFF" else row.color = "0xFFFFFFFF"
    row.width = w - 24
    row.wrap = true
    row.maxLines = 2
    list.appendChild(row)
    if it.notes <> invalid and it.notes <> ""
      note = CreateObject("roSGNode", "Label")
      note.text = it.notes
      note.font = "font:SmallSystemFont"
      note.color = "0xCBD5E1FF"
      note.width = w - 24
      note.wrap = true
      note.maxLines = 3
      list.appendChild(note)
    end if
  end for
  g.appendChild(list)
  return g
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
