import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowRight, Building2, MapPin } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorBanner, PageHeader } from '../components/ui';

const schema = z.object({
  title: z.string().min(3, 'Batch title must be at least 3 characters'),
  courseName: z.string().min(2, 'Course name is required'),
  courseCode: z.string().min(2, 'Course code is required'),
  startDate: z.string().optional(),
  completionDate: z.string().min(1, 'Completion date is required'),
});

type FormValues = z.infer<typeof schema>;

export function CreateBatchPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [serverErr, setServerErr] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      completionDate: new Date().toISOString().slice(0, 10),
    },
  });

  const onSubmit = async (values: FormValues) => {
    setServerErr(null);
    try {
      const res = await api.post('/batches', {
        title: values.title,
        courseName: values.courseName,
        courseCode: values.courseCode,
        startDate: values.startDate || null,
        completionDate: values.completionDate,
      });
      toast.success('Draft batch created. Now upload candidate CSV/Excel.');
      navigate(`/batches/${res.data.data.id}`);
    } catch (err) {
      setServerErr(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Create Training Batch"
        subtitle="District and Training Center are automatically bound from your verified session."
      />

      {/* Server-derived context banner */}
      <Card className="bg-slate-50/80 p-4">
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div className="flex items-center gap-2.5">
            <Building2 className="h-4 w-4 text-teal-700" />
            <div>
              <div className="text-slate-500">Training Center (Locked)</div>
              <div className="font-semibold text-slate-900">{user?.trainingCenter?.name ?? '—'}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <MapPin className="h-4 w-4 text-teal-700" />
            <div>
              <div className="text-slate-500">District (Locked)</div>
              <div className="font-semibold text-slate-900">{user?.district?.name ?? '—'}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        {serverErr && (
          <div className="mb-4">
            <ErrorBanner message={serverErr} />
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Batch Title</label>
            <input
              {...register('title')}
              placeholder="e.g., Solar PV Technician — November Cohort"
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            />
            {errors.title && <p className="mt-1 text-xs text-rose-600">{errors.title.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Course Name</label>
              <input
                {...register('courseName')}
                placeholder="e.g., Solar PV Installation Technician"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
              {errors.courseName && <p className="mt-1 text-xs text-rose-600">{errors.courseName.message}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Course Code</label>
              <input
                {...register('courseCode')}
                placeholder="SOL-101"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase focus:border-teal-600 focus:outline-none"
              />
              {errors.courseCode && <p className="mt-1 text-xs text-rose-600">{errors.courseCode.message}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Start Date (Optional)</label>
              <input
                type="date"
                {...register('startDate')}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Completion Date</label>
              <input
                type="date"
                {...register('completionDate')}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
              {errors.completionDate && <p className="mt-1 text-xs text-rose-600">{errors.completionDate.message}</p>}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={() => navigate('/batches')}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create & Continue to CSV Upload'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
