// Direct lookup endpoints (no model involved). Mounted at /api/tools.
import { Router } from 'express';
import { Queries } from '../db/queries.js';
import { HttpError } from '../errors.js';
import { dayFromISO, toDay3 } from '../utils/dates.js';

export const tools = Router();

const SOURCE_TYPES = ['timetable', 'calendar', 'notices'];

tools.post('/find_next_class', (req, res) => {
    const { course_code, date } = req.body || {};
    if (!course_code || !date) throw new HttpError(400, 'course_code and date required');
    const day = dayFromISO(date);
    if (!day) throw new HttpError(400, 'date must be YYYY-MM-DD');
    res.json({ next_class: Queries.findNextClass(String(course_code), day) || null });
});

tools.post('/get_day_schedule', (req, res) => {
    const { day, dept } = req.body || {};
    const day3 = toDay3(day);
    if (!day3) throw new HttpError(400, 'day required, e.g. "Monday"');
    res.json({ schedule: Queries.getDaySchedule(day3, dept ? String(dept) : null) });
});

tools.post('/search_calendar', (req, res) => {
    const { keyword } = req.body || {};
    if (!keyword) throw new HttpError(400, 'keyword required');
    res.json({ events: Queries.searchCalendar(String(keyword)) });
});

tools.post('/search_notices', (req, res) => {
    const { keyword } = req.body || {};
    if (!keyword) throw new HttpError(400, 'keyword required');
    res.json({ notices: Queries.searchNotices(String(keyword)) });
});

tools.get('/list_sources/:type', (req, res) => {
    if (!SOURCE_TYPES.includes(req.params.type)) throw new HttpError(400, 'unknown source type');
    // File names only: this endpoint is public
    const sources = Queries.listSources(req.params.type).map(({ type, source_file, semester }) => ({
        type,
        source_file,
        semester,
    }));
    res.json({ sources });
});
